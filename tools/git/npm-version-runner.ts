import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "../../ux/plan/manager.js";
import { execGit } from "./git.js";
import { startGitProgress } from "./progress.js";

const execFileAsync = promisify(execFile);
const FILES = ["package.json", "package-lock.json"];
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];

type VersionFile = { version?: unknown; packages?: Record<string, { version?: unknown }> };

async function cleanHead(cwd: string): Promise<string> {
  const [head, branch, status, ...markers] = await Promise.all([
    execGit(["rev-parse", "--verify", "HEAD"], cwd).catch(() => ""),
    execGit(["symbolic-ref", "--quiet", "HEAD"], cwd).catch(() => ""),
    execGit(["status", "--porcelain", "--untracked-files=normal", "--ignore-submodules=none"], cwd),
    ...OPERATION_MARKERS.map((marker) => execGit(["rev-parse", "--git-path", marker], cwd)),
  ]);
  if (!head.trim() || !branch.trim()) throw new Error("Check out a branch with an existing commit first.");
  if (markers.some((marker) => existsSync(resolve(cwd, marker.trim())))) {
    throw new Error("Finish or abort the in-progress Git operation first.");
  }
  if (status.trim()) throw new Error("Commit or stash existing changes first. The worktree and index must be clean.");
  return `${branch.trim()} ${head.trim()}`;
}

async function getPushTarget(cwd: string, branch: string): Promise<{ remote: string; ref: string } | undefined> {
  const output = await execGit(["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)", "--", branch], cwd);
  const [remote, ref] = output.trimEnd().split("\t");
  if (!remote || remote === "." || !ref?.startsWith("refs/heads/") || /[\p{Cc}\p{Bidi_Control}]/u.test(remote + ref)) return undefined;
  return { remote, ref };
}

function readVersion(files: string[]): string {
  const [manifest, lockfile] = files.map((file) => JSON.parse(file) as VersionFile);
  const version = manifest?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version) ||
      lockfile?.version !== version || lockfile?.packages?.[""]?.version !== version) {
    throw new Error("Expected a valid version in package.json and matching root versions in package-lock.json (npm lockfile v2 or newer).");
  }
  return version;
}

function withoutVersions(file: string, lockfile: boolean): VersionFile {
  const data = JSON.parse(file) as VersionFile;
  delete data.version;
  if (lockfile && data.packages?.[""]) delete data.packages[""].version;
  return data;
}

async function diffVersionFile(directory: string, file: string): Promise<string> {
  try {
    await execGit(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/",
      "--", `before/${file}`, `after/${file}`], directory);
    throw new Error(`No version change in ${file}.`);
  } catch (error) {
    const { code, stdout } = error as { code?: number; stdout?: string };
    if (code !== 1 || !stdout?.startsWith("diff --git ")) throw error;
    return stdout.replace(/^(diff --git |--- )a\/before\//gm, "$1a/")
      .replace(/^(diff --git a\/\S+ |\+\+\+ )b\/after\//gm, "$1b/");
  }
}

/** Return a staging candidate only after a successful push to origin/main. */
export async function prepareNpmVersion(ctx: ExtensionCommandContext, bump: "patch" | "minor" | "major"): Promise<string | undefined> {
  const plan = PlanModeManager.getInstance();
  if (plan.isEnabled()) {
    ctx.ui.notify("Cannot create a version commit in Plan Mode. Switch with /implement first.", "warning");
    return;
  }

  let directory: string | undefined;
  let applied = false;
  let committed = false;
  let progress: ReturnType<typeof startGitProgress> | undefined;
  try {
    const root = (await execGit(["rev-parse", "--show-toplevel"], ctx.cwd)).trim();
    const head = await cleanHead(root);
    const [branch, parent] = head.split(" ");
    await execGit(["ls-files", "--error-unmatch", "--", ...FILES], root).catch(() => {
      throw new Error("Track both package.json and package-lock.json at the repository root first.");
    });
    const before = await Promise.all(FILES.map(async (file) => {
      const path = join(root, file);
      if (!(await fs.lstat(path)).isFile()) throw new Error(`${file} must be a regular file.`);
      return fs.readFile(path, "utf8");
    }));
    const previous = readVersion(before);

    progress = startGitProgress(ctx, "git-npm-version", "Preparing npm version diff…");
    directory = await fs.mkdtemp(join(tmpdir(), "pi-npm-version-"));
    const beforeDir = join(directory, "before");
    const afterDir = join(directory, "after");
    await Promise.all([fs.mkdir(beforeDir), fs.mkdir(afterDir)]);
    await Promise.all(FILES.flatMap((file, i) => [beforeDir, afterDir].map((folder) => fs.writeFile(join(folder, file), before[i]!))));
    const npmArgs = ["version", bump, "--no-git-tag-version", "--ignore-scripts", "--workspaces=false"];
    try {
      if (process.platform === "win32") {
        await execFileAsync("cmd.exe", ["/d", "/c", "npm", ...npmArgs], { cwd: afterDir, timeout: 30_000 });
      } else {
        await execFileAsync("npm", npmArgs, { cwd: afterDir, timeout: 30_000 });
      }
    } catch {
      throw new Error("npm could not calculate the version bump. Check that npm is installed and the manifests are valid.");
    }
    const after = await Promise.all(FILES.map((file) => fs.readFile(join(afterDir, file), "utf8")));
    const next = readVersion(after);
    if (next === previous || !before.every((file, i) => isDeepStrictEqual(withoutVersions(file, i === 1), withoutVersions(after[i]!, i === 1)))) {
      throw new Error("npm did not produce a version-only change.");
    }
    const diffs = await Promise.all(FILES.map((file) => diffVersionFile(directory!, file)));
    const preview = diffs.map((diff, index) => {
      const changed = diff.split(/\r?\n/).filter((line) => /^[+-](?![+-])/.test(line));
      if (changed.length !== (index === 0 ? 2 : 4) || changed.some((line) => !/^[+-]\s*"version":\s*"[^"\r\n]+",?$/.test(line))) {
        throw new Error(`Unexpected formatting changes in ${FILES[index]}. Review and bump the version manually.`);
      }
      return `${FILES[index]}\n${changed.join("\n")}`;
    });
    const message = `chore(release): v${next}`;
    const target = await getPushTarget(root, branch);
    const destination = target ? `${target.remote}/${target.ref.slice("refs/heads/".length)}` : undefined;
    const commitOnly = "Commit only";
    const commitAndPush = "Commit & Push";
    progress.close();
    const choice = await ctx.ui.select([
      "Review npm version commit",
      `${previous} → ${next} (${bump})`, message, ...preview,
      destination ? `Push target: ${destination}. An ordinary push can include earlier unpushed commits.` : "No upstream branch configured. Commit locally or set an upstream first.",
      destination === "origin/main"
        ? "After a successful push to origin/main, review npm staging separately. No Git tag is created."
        : "Push or merge the commit to origin/main before staging. No Git tag is created.",
    ].join("\n"), [commitOnly, ...(target ? [commitAndPush] : [])]);
    const push = choice === commitAndPush && target;
    if (choice !== commitOnly && !push) return;
    if (plan.isEnabled()) throw new Error("Plan Mode is active. No version files were changed.");

    const patch = join(directory, "version.patch");
    await fs.writeFile(patch, diffs.join(""));
    if (await cleanHead(root) !== head) throw new Error("The branch or commit changed during review. Run the bump again.");
    const current = await Promise.all(FILES.map((file) => fs.readFile(join(root, file), "utf8")));
    if (current.some((file, i) => file !== before[i])) throw new Error("The version files changed during review. Run the bump again.");
    if (push && !isDeepStrictEqual(await getPushTarget(root, branch), push)) {
      throw new Error("The upstream changed during review. Run the bump again.");
    }
    if (plan.isEnabled()) throw new Error("Plan Mode is active. No version files were changed.");
    progress = startGitProgress(ctx, "git-npm-version", "Creating npm version commit…");
    await execGit(["apply", "--index", "--", patch], root);
    applied = true;
    await execGit(["commit", "--only", "-m", message, "--", ...FILES], root);
    committed = true;
    if (!push) {
      ctx.ui.notify(`Created ${message} locally. Once it reaches origin/main, run /git release npm and choose Stage current version.`, "info");
      return;
    }

    const [currentBranch, sha] = (await cleanHead(root)).split(" ");
    const [commitParent, subject] = (await execGit(["show", "-s", "--format=%P%n%s", sha], root)).trimEnd().split("\n");
    if (currentBranch !== branch || commitParent !== parent || subject !== message || !isDeepStrictEqual(await getPushTarget(root, branch), push)) {
      throw new Error("The branch, commit, or upstream changed. Check Git status before pushing.");
    }
    if (plan.isEnabled()) throw new Error("Plan Mode is active. Nothing was pushed.");
    progress.update(`Pushing version commit to ${destination}…`);
    try {
      await execGit(["push", "--no-follow-tags", "--recurse-submodules=no", "--", push.remote, `${sha}:${push.ref}`], root);
    } catch {
      throw new Error(`Git could not confirm the push to ${destination}. Check the upstream and push the existing commit manually; do not rerun the bump.`);
    }
    if (push.remote === "origin" && push.ref === "refs/heads/main") {
      ctx.ui.notify(`Created ${message} and pushed it to ${destination}.`, "info");
      return sha;
    }
    ctx.ui.notify(`Created ${message} and pushed it to ${destination}. Once it reaches origin/main, run /git release npm and choose Stage current version.`, "info");
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Could not parse the npm manifests."
      : error instanceof Error ? error.message : "Unexpected error.";
    const message = committed ? `Version commit created locally. ${reason}`
      : applied ? "Git did not complete the commit. Review git status before retrying." : reason;
    ctx.ui.notify(`npm version: ${message}`, "error");
  } finally {
    progress?.close();
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
