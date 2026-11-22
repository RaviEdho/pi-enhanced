import { execFile } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "../../ux/plan/manager.js";
import { execGit, isGitRepository } from "./git.js";

const execFileAsync = promisify(execFile);
const BUMPS = ["patch", "minor", "major"] as const;
const FILES = ["package.json", "package-lock.json"];
const OPERATION_MARKERS = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];

type VersionFile = { version?: unknown; packages?: Record<string, { version?: unknown }> };

function isBump(value: string | undefined): value is typeof BUMPS[number] {
  return BUMPS.some((bump) => bump === value);
}

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

export async function handleNpmVersionCommand(ctx: ExtensionCommandContext, args = ""): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("Creating a version commit requires confirmation in Pi's terminal UI.", "warning");
    return;
  }
  const plan = PlanModeManager.getInstance();
  if (plan.isEnabled()) {
    ctx.ui.notify("Cannot create a version commit in Plan Mode. Switch with /implement first.", "warning");
    return;
  }
  const requested = args.trim();
  if (requested && !isBump(requested)) {
    ctx.ui.notify("Usage: /git release npm bump [patch|minor|major]", "warning");
    return;
  }
  if (!(await isGitRepository(ctx.cwd))) {
    ctx.ui.notify("Run this command inside a Git repository.", "warning");
    return;
  }

  let directory: string | undefined;
  let applied = false;
  try {
    const root = (await execGit(["rev-parse", "--show-toplevel"], ctx.cwd)).trim();
    const head = await cleanHead(root);
    await execGit(["ls-files", "--error-unmatch", "--", ...FILES], root).catch(() => {
      throw new Error("Track both package.json and package-lock.json at the repository root first.");
    });
    const before = await Promise.all(FILES.map(async (file) => {
      const path = join(root, file);
      if (!(await fs.lstat(path)).isFile()) throw new Error(`${file} must be a regular file.`);
      return fs.readFile(path, "utf8");
    }));
    const previous = readVersion(before);
    const bump = requested || await ctx.ui.select(`Version bump (current: ${previous})`, [...BUMPS]);
    if (!isBump(bump)) return;

    ctx.ui.setWorkingMessage?.("Preparing npm version diff…");
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
    ctx.ui.setWorkingMessage?.();
    if (!(await ctx.ui.confirm("Create npm version commit?", [
      `${previous} → ${next} (${bump})`, message, ...preview, "No tag, push, or npm staging.",
    ].join("\n\n")))) return;
    if (plan.isEnabled()) throw new Error("Plan Mode is active. No version files were changed.");

    const patch = join(directory, "version.patch");
    await fs.writeFile(patch, diffs.join(""));
    if (await cleanHead(root) !== head) throw new Error("The branch or commit changed during review. Run the bump again.");
    const current = await Promise.all(FILES.map((file) => fs.readFile(join(root, file), "utf8")));
    if (current.some((file, i) => file !== before[i])) throw new Error("The version files changed during review. Run the bump again.");
    ctx.ui.setWorkingMessage?.("Creating npm version commit…");
    await execGit(["apply", "--index", "--", patch], root);
    applied = true;
    await execGit(["commit", "--only", "-m", message, "--", ...FILES], root);
    ctx.ui.notify(`Created ${message}. Push or merge it to main, then run /git release npm.`, "info");
  } catch (error) {
    const reason = error instanceof SyntaxError ? "Could not parse the npm manifests."
      : error instanceof Error ? error.message : "Unexpected error.";
    ctx.ui.notify(`npm version: ${applied ? "Git did not complete the commit. Review git status before retrying." : reason}`, "error");
  } finally {
    if (directory) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    ctx.ui.setWorkingMessage?.();
  }
}
