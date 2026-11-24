import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "../../ux/plan/manager.js";
import { chooseReleaseNotes, type ReleaseNotesContext } from "./release-notes.js";
import { isReleaseBump, nextReleaseVersion, selectReleaseVersion } from "./release-version-selector.js";
import { confirmGitReview } from "./review-dialog.js";

const USAGE = "/git release ship [patch|minor|major|X.Y.Z], push <tag>, or status <tag>";
const remote = "origin";
const versionFile = "package.json";
const npmFiles = [versionFile, "package-lock.json", "npm-shrinkwrap.json"];
const companionFiles = ["src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock", "tauri.conf.json", "Cargo.toml", "Cargo.lock"];
const otherLockfiles = ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"];
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

type Action = "ship" | "push" | "status";
type Exec = ExtensionAPI["exec"];
type Context = Pick<ExtensionCommandContext, "cwd" | "hasUI" | "mode" | "isProjectTrusted"> & ReleaseNotesContext;
type Adapter = { files: string[]; scripts?: { bump: string; check: string } };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object.");
  return value as Record<string, unknown>;
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

async function safeFile(root: string, file: string): Promise<string> {
  const absolute = path.resolve(root, file);
  const resolved = await realpath(absolute);
  if (path.relative(absolute, resolved) !== "") throw new Error(`Release files cannot be symbolic links: ${file}`);
  return resolved;
}

function versionFrom(text: string): string {
  return matching(object(JSON.parse(text)).version, stable, "stable X.Y.Z version");
}

function targetVersion(current: string, choice: string): string {
  if (isReleaseBump(choice)) return matching(nextReleaseVersion(current, choice), stable, "next version");

  const desired = matching(choice, stable, "target version (use patch, minor, major, or X.Y.Z)");
  const parts = current.split(".").map(Number);
  const firstDifference = desired.split(".").map((value, index) => Number(value) - parts[index]!).find(diff => diff !== 0);
  if (firstDifference !== undefined && firstDifference < 0) throw new Error(`Cannot release a version older than ${current}.`);
  return desired;
}

async function chooseTargetVersion(ctx: Context, current: string): Promise<string | undefined> {
  const custom = "Custom version…";
  const selected = await selectReleaseVersion(ctx.ui, current, custom, version => stable.test(version));
  return selected === custom ? (await ctx.ui.input("Release version (X.Y.Z)", "e.g. 1.2.3"))?.trim() : selected;
}

// Remote URLs can contain credentials or arbitrary helper syntax. Keep them out of logs and previews.
function destinationLabel(url: string): string {
  try {
    const parsed = new URL(url);
    if (["https:", "http:", "ssh:"].includes(parsed.protocol)) return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { /* SCP-style Git URLs aren't standard URLs. */ }
  const scp = /^(?:[^@/:]+@)?([a-zA-Z0-9.-]+):([a-zA-Z0-9._/-]+)$/.exec(url);
  return scp && scp[1]!.length > 1 ? `${scp[1]}:${scp[2]}` : "configured Git destination";
}

function githubRepo(url: string): string | undefined {
  return /^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url)?.[1];
}

async function npmCommand(): Promise<string[]> {
  if (process.platform !== "win32") return ["npm"];
  // Node's shell-free process runner cannot launch npm.cmd on Windows.
  const dirs = [path.dirname(process.execPath), ...(process.env.PATH ?? "").split(path.delimiter)];
  for (const dir of dirs) {
    const base = dir.replace(/^"|"$/g, "");
    if (!path.isAbsolute(base)) continue;
    const cli = path.join(base, "node_modules", "npm", "bin", "npm-cli.js");
    if (await stat(cli).then(info => info.isFile(), () => false)) return [process.execPath, cli];
  }
  throw new Error("Could not find the npm CLI. Install Node.js with npm and make it available on PATH.");
}

class ReleaseRepo {
  constructor(readonly exec: Exec, readonly root: string) {}

  run(command: string, args: string[], timeout = 30_000) {
    return this.exec(command, args, { cwd: this.root, timeout, maxBuffer: 1024 * 1024 });
  }

  async git(args: string[], error: string, timeout?: number): Promise<string> {
    const result = await this.run("git", args, timeout);
    if (result.code !== 0 || result.killed || result.truncated) throw new Error(error);
    return result.stdout;
  }

  async destination(): Promise<string> {
    const mirror = await this.run("git", ["config", "--type=bool", "--get", `remote.${remote}.mirror`]);
    if (![0, 1].includes(mirror.code) || mirror.killed || mirror.truncated || mirror.stdout.trim() === "true") {
      throw new Error("Mirror remotes cannot be used for releases.");
    }
    const urls = (await this.git(["remote", "get-url", "--push", "--all", remote], `Could not resolve push remote ${remote}.`)).trim().split(/\r?\n/);
    if (urls.length !== 1 || !urls[0] || urls[0].startsWith("-") || urls[0].includes("::")) {
      throw new Error("Configure exactly one push URL without remote-helper syntax.");
    }
    return urls[0];
  }

  async defaultBranch(destination: string): Promise<string> {
    const result = await this.git(["ls-remote", "--symref", "--", destination, "HEAD"], "Could not read the default branch on origin.");
    const branch = /^ref: refs\/heads\/([^\t\r\n]+)\tHEAD\r?$/m.exec(result)?.[1];
    if (!branch) throw new Error("origin does not advertise a default branch. Set it on the remote first.");
    await this.git(["check-ref-format", `refs/heads/${branch}`], "origin advertised an invalid default branch.");
    return branch;
  }

  async state(branch: string): Promise<{ head: string; status: string }> {
    const current = (await this.git(["symbolic-ref", "--quiet", "HEAD"], "Cannot release from detached HEAD.")).trim();
    if (current !== `refs/heads/${branch}`) throw new Error(`Switch to origin’s default branch (${branch}) before releasing.`);
    const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-apply", "rebase-merge", "sequencer", "BISECT_START"];
    for (const marker of markers) {
      const markerPath = (await this.git(["rev-parse", "--git-path", marker], "Could not inspect Git operation state.")).trim();
      try {
        await realpath(path.resolve(this.root, markerPath));
        throw new Error("Finish or abort the current Git operation before releasing.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const head = matching((await this.git(["rev-parse", "--verify", "HEAD^{commit}"], "No commit to release.")).trim(), oidPattern, "HEAD commit");
    const status = await this.git(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], "Could not inspect working tree.");
    return { head, status };
  }

  async localTag(tag: string): Promise<string | undefined> {
    const ref = `refs/tags/${tag}`;
    const refs = await this.git(["for-each-ref", "--format=%(objectname)%09%(refname)", ref], `Could not inspect local tag ${tag}.`);
    const entry = refs.trim().split(/\r?\n/).find(line => line.split("\t")[1] === ref);
    return entry ? matching(entry.split("\t")[0], oidPattern, "local tag object") : undefined;
  }

  async remoteRef(destination: string, ref: string): Promise<string | undefined> {
    const result = await this.git(["ls-remote", "--refs", "--", destination, ref], "Could not inspect the remote refs. Check network access and authentication.");
    const match = result.trim().split(/\r?\n/).find(line => line.split("\t")[1] === ref);
    return match ? matching(match.split("\t")[0], oidPattern, "remote ref object") : undefined;
  }

  async requireAncestor(destination: string, branch: string, head: string): Promise<string> {
    const upstream = await this.remoteRef(destination, `refs/heads/${branch}`);
    if (!upstream) throw new Error(`Remote branch ${branch} does not exist.`);
    await this.git(["cat-file", "-e", `${upstream}^{commit}`], "The live remote commit is not available locally. Fetch and synchronize first.");
    await this.git(["merge-base", "--is-ancestor", upstream, head], "The local release branch is behind or diverged from the remote. Synchronize first.");
    return upstream;
  }

  async commitsForNotes(head: string): Promise<string[]> {
    const tags = await this.git(["for-each-ref", `--merged=${head}`, "--sort=-version:refname", "--format=%(refname)", "refs/tags"],
      "Could not find the previous release tag.");
    const previous = tags.split(/\r?\n/).find(ref => ref.startsWith("refs/tags/v") && stable.test(ref.slice("refs/tags/v".length)));
    const range = previous ? `${previous}..${head}` : head;
    const log = await this.git(["log", "--no-merges", "-101", "--format=%h %s", range, "--"], "Could not read commits for release notes.");
    return log.trim().split(/\r?\n/).filter(Boolean);
  }

  async createTag(tag: string, version: string, commit: string, notes?: string): Promise<void> {
    const title = `Release ${version}`;
    const message = `Could not create annotated tag ${tag}.`;
    if (!notes) {
      await this.git(["tag", "-a", "-m", title, tag, commit], message);
      return;
    }
    // Use a temporary file so multiline notes don't hit Windows command-line length limits.
    const directory = await mkdtemp(path.join(tmpdir(), "pi-release-notes-"));
    try {
      const file = path.join(directory, "notes.md");
      await writeFile(file, `${title}\n\n${notes}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await this.git(["tag", "-a", "--cleanup=verbatim", "-F", file, tag, commit], message);
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
    }
  }

  async packageAt(head: string): Promise<string> {
    return this.git(["show", `${head}:${versionFile}`], "No committed package.json found at the Git root.");
  }

  async adapter(head: string, manifest: string): Promise<Adapter> {
    const files = (await this.git(["ls-tree", "-z", "--name-only", head, "--", ...npmFiles, ...companionFiles, ...otherLockfiles],
      "Could not identify tracked version files.")).split("\0").filter(Boolean);
    const pkg = object(JSON.parse(manifest));
    const scripts = object(pkg.scripts ?? {});
    const bump = scripts["version:set"];
    const check = scripts["version:check"];
    const usesOtherManager = typeof pkg.packageManager === "string" && !pkg.packageManager.startsWith("npm@");
    if (bump !== undefined || check !== undefined || usesOtherManager
      || files.some(file => companionFiles.includes(file) || otherLockfiles.includes(file))) {
      if (typeof bump !== "string" || !bump.trim() || typeof check !== "string" || !check.trim()) {
        throw new Error("Projects with companion manifests or custom versioning need both version:set and version:check scripts in package.json.");
      }
      return { files, scripts: { bump, check } };
    }
    return { files };
  }

  async runNpm(npm: string[], args: string[]): Promise<void> {
    const [command, ...before] = npm;
    const result = await this.run(command!, [...before, "--ignore-scripts", ...args], 120_000);
    if (result.code !== 0 || result.killed || result.truncated) {
      throw new Error(`npm ${args.slice(0, 2).join(" ")} failed (exit ${result.code}). Check the command locally. Any version edits were left in place.`);
    }
  }

  async checkVersion(adapter: Adapter, npm: string[] | undefined, version: string, tag: string): Promise<void> {
    if (adapter.scripts) await this.runNpm(npm!, ["run", "version:check", "--", tag]);
    const actual = versionFrom(await readFile(await safeFile(this.root, versionFile), "utf8"));
    if (actual !== version) throw new Error(`package.json reports ${actual}, expected ${version}.`);
    if (!adapter.scripts) {
      for (const file of adapter.files.filter(file => file === "package-lock.json" || file === "npm-shrinkwrap.json")) {
        const lock = object(JSON.parse(await readFile(await safeFile(this.root, file), "utf8")));
        const rootPackage = lock.packages === undefined ? undefined : object(lock.packages)[""];
        if (lock.version !== version || (rootPackage !== undefined && object(rootPackage).version !== version)) {
          throw new Error(`${file} does not match version ${version}.`);
        }
      }
    }
  }

  async diff(cached = false): Promise<string> {
    return this.git(["diff", ...(cached ? ["--cached"] : []), "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], "Could not inspect the version diff.");
  }

  async push(destination: string, branch: string, head: string, tag: string, objectId: string): Promise<void> {
    if (await this.destination() !== destination || await this.defaultBranch(destination) !== branch) {
      throw new Error("The push remote or its default branch changed. Nothing was pushed.");
    }
    const state = await this.state(branch);
    if (state.head !== head || state.status || await this.localTag(tag) !== objectId) throw new Error("HEAD, the working tree, or the tag changed. Nothing was pushed.");
    await this.git(["push", "--atomic", "--no-follow-tags", "--", remote, `${head}:refs/heads/${branch}`, `${objectId}:refs/tags/${tag}`],
      `Push failed or was interrupted. The local commit and tag were kept. Use /git release status ${tag} before retrying /git release push ${tag}.`, 120_000);
  }
}

function changedPaths(status: string, allowed: string[]): string[] {
  const entries = status.split("\0").filter(Boolean);
  // Only modified, unstaged, tracked version files are allowed. Refuse renames, symlinks below, and untracked files.
  if (entries.some(entry => !entry.startsWith(" M ") || !allowed.includes(entry.slice(3)))) {
    throw new Error("The adapter changed files outside the allowed unstaged version edits. Review your working tree; nothing was committed.");
  }
  return entries.map(entry => entry.slice(3));
}

function preview(text: string, limit = 1800, more = "truncated"): string {
  const plain = text.replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ");
  return plain.length > limit ? `${plain.slice(0, limit)}\n… (${more})` : plain;
}

async function inspectStatus(repo: ReleaseRepo, ctx: Context, destination: string, tag: string): Promise<void> {
  const local = await repo.localTag(tag);
  const remote = await repo.remoteRef(destination, `refs/tags/${tag}`);
  const status = [`${tag}: ${local ? "local tag" : "no local tag"}; ${remote ? "remote tag present" : "no remote tag"}.`];
  if (local && remote && local !== remote) status.push("Local and remote tag objects differ.");
  const github = githubRepo(destination);
  if (github && remote) {
    const prefix = `https://github.com/${github}`;
    try {
      const release = await repo.run("gh", ["release", "view", tag, "--repo", github, "--json", "isDraft,url"]);
      if (release.code === 0 && !release.killed && !release.truncated) {
        const data = object(JSON.parse(release.stdout));
        if (typeof data.isDraft === "boolean") status.push(`${data.isDraft ? "Draft release" : "Published release"}: ${prefix}/releases/tag/${tag}`);
      } else if (/release not found/i.test(release.stderr)) {
        status.push("No GitHub release found.");
      }
      const peeled = await repo.git(["ls-remote", "--", destination, `refs/tags/${tag}^{}`], "Could not resolve the tag commit.");
      const commit = matching(peeled.trim().split(/\s/)[0] || remote, oidPattern, "tagged commit");
      const runs = await repo.run("gh", ["run", "list", "--repo", github, "--branch", tag,
        "--commit", commit, "--event", "push", "--limit", "5", "--json", "workflowName,status,conclusion,databaseId"]);
      if (runs.code !== 0 || runs.killed || runs.truncated) throw new Error("Actions is unavailable.");
      const list = JSON.parse(runs.stdout) as Array<{ workflowName: string; status: string; conclusion: string; databaseId: number }>;
      if (!list.length) status.push(`No matching Actions run yet · ${prefix}/actions`);
      for (const run of list.filter(run => Number.isSafeInteger(run.databaseId))) {
        status.push(`${preview(run.workflowName || "Actions", 60)}: ${preview(run.conclusion || run.status || "unknown", 60)} · ${prefix}/actions/runs/${run.databaseId}`);
      }
    } catch {
      status.push(`Could not check Actions or Releases with gh · ${prefix}/actions`);
    }
  }
  report(ctx, status.join("\n"), "info");
}

function report(ctx: Context, message: string, level: "info" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else (level === "error" ? process.stderr : process.stdout).write(`${message}\n`);
}

export async function handleReleaseWorkflow(action: Action, argument: string, ctx: Context, exec: Exec): Promise<void> {
  if (action !== "status" && PlanModeManager.getInstance().isEnabled()) {
    ctx.ui.notify("Switch to implement mode before shipping a release.", "warning");
    return;
  }
  if (!ctx.hasUI && action !== "status") {
    report(ctx, "Shipping a release requires interactive approval.", "error");
    return;
  }
  if (!ctx.isProjectTrusted()) {
    report(ctx, "Trust this project before using its release commands.", "error");
    return;
  }
  let createdTag: string | undefined;
  try {
    if ((!argument && action !== "ship") || /\s/.test(argument)) throw new Error(USAGE);
    const result = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 5000 });
    if (result.code !== 0 || result.killed || result.truncated) throw new Error("Open a Git working tree before releasing.");
    const root = await realpath(result.stdout.trim());
    const repo = new ReleaseRepo(exec, root);
    const destination = await repo.destination();
    const taggedVersion = () => matching(argument.startsWith("v") ? argument.slice(1) : "", stable, "tag (expected vX.Y.Z)");
    if (action === "status") {
      taggedVersion();
      await inspectStatus(repo, ctx, destination, argument);
      return;
    }

    const branch = await repo.defaultBranch(destination);
    const { head, status } = await repo.state(branch);
    if (status) throw new Error("Commit or set aside existing changes before releasing.");
    const manifest = await repo.packageAt(head);
    const current = versionFrom(manifest);
    const choice = action === "ship" && !argument ? await chooseTargetVersion(ctx, current) : argument;
    if (choice === undefined) return;
    const version = action === "ship" ? targetVersion(current, choice) : taggedVersion();
    const tag = `v${version}`;
    const tagRef = `refs/tags/${tag}`;
    const local = await repo.localTag(tag);
    const remote = await repo.remoteRef(destination, tagRef);
    if (action === "ship" && local) throw new Error(`Tag ${tag} already exists locally. Use /git release status ${tag} or /git release push ${tag}.`);
    if (action === "push") {
      if (!local) throw new Error(`Tag ${tag} does not exist locally.`);
      await repo.git(["cat-file", "-e", `${local}^{tag}`], "Retry requires an annotated release tag.");
      const target = (await repo.git(["rev-parse", "--verify", `${local}^{commit}`], "The release tag does not point to a commit.")).trim();
      if (target !== head || current !== version) throw new Error(`Tag ${tag} must point to the current ${branch} HEAD with matching version ${version}.`);
      if (local === remote) {
        ctx.ui.notify(`${tag} is already pushed. Use /git release status ${tag}.`, "info");
        return;
      }
    }
    if (remote) throw new Error(`Tag ${tag} already exists on origin. It will not be overwritten.`);
    const upstream = await repo.requireAncestor(destination, branch, head);
    const bump = action === "ship" && current !== version;
    const adapter = await repo.adapter(head, manifest);
    const npm = bump || adapter.scripts ? await npmCommand() : undefined;
    let notes: string | undefined;
    if (action === "ship") {
      const choice = await chooseReleaseNotes(ctx, tag, () => repo.commitsForNotes(head));
      if (!choice) return;
      notes = choice.notes;
    }
    if (npm && !await confirmGitReview(ctx, "Run project release commands?", [
      `${current} → ${version} on ${branch}`,
      ...(bump ? [adapter.scripts
        ? `npm run version:set -- ${version}\n  ${preview(adapter.scripts.bump, 220)}`
        : `npm version ${version} --no-git-tag-version --ignore-scripts --workspaces=false`] : []),
      ...(adapter.scripts ? [`npm run version:check -- ${tag}\n  ${preview(adapter.scripts.check, 220)}`] : ["Verify the npm manifest and tracked lockfiles."]),
      "No commit, tag, or push happens until the next approval.",
    ], "Run commands")) return;

    const before = await repo.state(branch);
    if (before.head !== head || before.status) throw new Error("The checkout changed. Restart the release command.");
    for (const file of adapter.files) await safeFile(root, file);
    if (bump) await repo.runNpm(npm!, adapter.scripts
      ? ["run", "version:set", "--", version]
      : ["version", version, "--no-git-tag-version", "--workspaces=false"]);
    // Reject unexpected writes from the bump before running any check script.
    const bumped = await repo.state(branch);
    if (bumped.head !== head || (!bump && bumped.status)) throw new Error("The version command changed the checkout unexpectedly.");
    const files = changedPaths(bumped.status, adapter.files);
    if (bump && !files.includes(versionFile)) throw new Error("The version command did not update package.json.");
    for (const file of adapter.files) await safeFile(root, file);
    const diff = bump ? await repo.diff() : "";
    await repo.checkVersion(adapter, npm, version, tag);
    const checked = await repo.state(branch);
    if (checked.head !== head || checked.status !== bumped.status || (bump && await repo.diff() !== diff)) {
      throw new Error("The version check changed the checkout. Review it before releasing.");
    }
    const commits = (await repo.git(["log", "--oneline", "-12", `${upstream}..${head}`], "Could not review outgoing commits.")).trim();
    const tuiReview = ctx.mode === "tui";
    if (!await confirmGitReview(ctx, `Push ${tag}?`, [
      `origin (${destinationLabel(destination)}) · ${branch} · ${head.slice(0, 12)}`,
      "Pushing this tag may publish a release.",
      ...(commits ? [`\nOutgoing commits (up to 12):\n${preview(commits, tuiReview ? 4_000 : 800)}`] : []),
      ...(bump ? [`\nNew commit: Release ${version}\nFiles: ${files.map(file => preview(file, 120)).join(", ")}\n${preview(diff, tuiReview ? 32_000 : 1800, "truncated; review with git diff")}`] : []),
      ...(notes ? [`\nRelease notes in ${tag}:\n${tuiReview ? notes : preview(notes, 420)}`] : []),
    ], `Push ${tag}`)) {
      if (bump) ctx.ui.notify("Version edits were kept; nothing was committed or pushed.", "info");
      return;
    }

    const approved = await repo.state(branch);
    if (approved.head !== head || approved.status !== checked.status || (bump && await repo.diff() !== diff)
      || await repo.destination() !== destination || await repo.defaultBranch(destination) !== branch || await repo.localTag(tag) !== local
      || await repo.remoteRef(destination, tagRef) || await repo.requireAncestor(destination, branch, head) !== upstream) {
      throw new Error("The release state changed during review. Restart the release command.");
    }

    let commit = head;
    if (bump) {
      await repo.git(["--literal-pathspecs", "add", "--", ...files], "Could not stage the version files.");
      if (await repo.diff(true) !== diff) throw new Error("Staged version changes differ from the approved diff. Review the index.");
      const tree = (await repo.git(["write-tree"], "Could not verify the release index.")).trim();
      await repo.git(["commit", "-m", `Release ${version}`], "Release commit failed. Review Git hooks and the index.");
      commit = (await repo.state(branch)).head;
      const parents = (await repo.git(["show", "-s", "--format=%P", commit], "Could not verify release commit ancestry.")).trim();
      const committedTree = (await repo.git(["show", "-s", "--format=%T", commit], "Could not verify release commit contents.")).trim();
      if (parents !== head || committedTree !== tree || versionFrom(await repo.packageAt(commit)) !== version) {
        throw new Error("The release commit did not match the reviewed changes. No tag was created.");
      }
      await repo.checkVersion(adapter, npm, version, tag);
    }
    const ready = await repo.state(branch);
    if (ready.head !== commit || ready.status) throw new Error("The checkout changed after validation. Nothing was pushed.");
    let tagObject = local;
    if (action === "ship") {
      await repo.createTag(tag, version, commit, notes);
      createdTag = tag;
      tagObject = await repo.localTag(tag);
    }
    if (!tagObject) throw new Error(`Tag ${tag} is missing. Nothing was pushed.`);
    await repo.push(destination, branch, commit, tag, tagObject);
    ctx.ui.notify(`${tag} pushed to origin. Use /git release status ${tag} to check for a build.`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown release error.";
    const hint = createdTag ? ` Local tag kept: ${createdTag}.` : "";
    report(ctx, `${message}${hint}`, "error");
  }
}
