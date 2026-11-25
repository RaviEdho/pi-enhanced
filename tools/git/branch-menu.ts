import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "../../ux/plan/manager.js";
import { readGitStatus, type GitStatus } from "../../ux/usage/git-status.js";
import { promptCreateBranch } from "./branch-create-dialog.js";
import { branchNameProblem, pickLocalBranch } from "./branch-runner.js";
import { execGit, hasGitHubCli, isGitRepository } from "./git.js";
import { confirmGitReview, selectGitMenu, type GitMenuAction } from "./review-dialog.js";
import { readMenuContext } from "./status-menu.js";

interface Upstream {
  source: string;
  head: string;
  tracking: string;
  remote: string;
  target: string;
}

function mutationBlocker(ctx: ExtensionCommandContext): string | undefined {
  if (PlanModeManager.getInstance().isEnabled()) return "Switch to Implement Mode first.";
  if (!ctx.isProjectTrusted()) return "Trust this project first.";
}

function dirty(status: GitStatus): boolean {
  return Boolean(status.staged || status.unstaged || status.untracked || status.conflicts);
}

async function currentUpstream(cwd: string): Promise<Upstream | undefined> {
  const source = (await execGit(["symbolic-ref", "HEAD"], cwd)).trimEnd();
  if (!source.startsWith("refs/heads/")) return;
  const [ref, head, tracking, remote, target] = (await execGit([
    "for-each-ref", "--format=%(refname)%09%(objectname)%09%(upstream)%09%(upstream:remotename)%09%(upstream:remoteref)", source,
  ], cwd)).trimEnd().split("\t");
  if (ref !== source || !head || !tracking?.startsWith("refs/remotes/") || !remote || remote === "." || !target?.startsWith("refs/heads/")) return;
  return { source, head, tracking, remote, target };
}

function sameUpstream(a: Upstream, b: Upstream | undefined): boolean {
  return Boolean(b && a.source === b.source && a.head === b.head && a.tracking === b.tracking &&
    a.remote === b.remote && a.target === b.target);
}

async function readCommit(cwd: string, ref: string): Promise<string> {
  return (await execGit(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd)).trimEnd();
}

async function inputBranchName(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const name = (await ctx.ui.input("New branch name", "e.g. feat/my-change"))?.trim();
  if (!name) return;
  const problem = await branchNameProblem(ctx.cwd, name);
  if (problem) ctx.ui.notify(problem, "warning");
  else return name;
}

function runRemoteGit(cwd: string, args: string[]): Promise<string> {
  return execGit(args, cwd, { GIT_TERMINAL_PROMPT: "0" }, 120_000);
}

async function remoteCommit(cwd: string, upstream: Upstream): Promise<string | undefined> {
  const output = await runRemoteGit(cwd, ["ls-remote", "--exit-code", "--refs", "--", upstream.remote, upstream.target]).catch(() => "");
  const [oid, ref] = output.trimEnd().split("\t");
  return ref === upstream.target ? oid : undefined;
}

async function remoteUrls(cwd: string, remote: string, push: boolean): Promise<string[]> {
  const out = await execGit(["remote", "get-url", "--all", ...(push ? ["--push"] : []), "--", remote], cwd).catch(() => "");
  return out.trimEnd().split(/\r?\n/).filter(Boolean);
}

function githubRepository(url: string): string | undefined {
  return /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(url)?.[1];
}

async function offerPush(ctx: ExtensionCommandContext, pi: ExtensionAPI, upstream: Upstream, name: string): Promise<void> {
  const { cwd } = ctx;
  const [fetchUrls, pushUrls] = await Promise.all([remoteUrls(cwd, upstream.remote, false), remoteUrls(cwd, upstream.remote, true)]);
  const repository = fetchUrls.length === 1 ? githubRepository(fetchUrls[0]!) : undefined;
  const pushRepo = pushUrls.length === 1 ? githubRepository(pushUrls[0]!) : undefined;
  if (fetchUrls.length !== 1 || pushUrls.length !== 1 || (fetchUrls[0] !== pushUrls[0] &&
      (!repository || repository.toLowerCase() !== pushRepo?.toLowerCase()))) {
    ctx.ui.notify("The commits were moved locally. This remote's fetch and push destinations differ or are ambiguous; no push was offered.", "info");
    return;
  }

  const draft = Boolean(repository && ctx.model && await hasGitHubCli());
  const action = draft ? "Push branch and draft PR" : "Push branch";
  const base = upstream.target.slice("refs/heads/".length);
  const ref = `refs/heads/${name}`;
  if (!await confirmGitReview(ctx, action, [
    `Push ${name} as a new branch to ${upstream.remote}${repository ? ` (${repository})` : ""}.`,
    ...(draft ? [`Draft a PR into ${base}. GitHub won't open a PR unless you choose Create pull request.`] : []),
  ], action)) return;

  const blocked = mutationBlocker(ctx);
  if (blocked) return ctx.ui.notify(blocked, "warning");
  const [branch, head, currentPushUrls] = await Promise.all([
    execGit(["symbolic-ref", "HEAD"], cwd).then(out => out.trimEnd(), () => undefined),
    readCommit(cwd, ref).catch(() => undefined),
    remoteUrls(cwd, upstream.remote, true),
  ]);
  if (branch !== ref || head !== upstream.head || currentPushUrls.length !== 1 || currentPushUrls[0] !== pushUrls[0]) {
    return ctx.ui.notify("The feature branch or push destination changed. Nothing was pushed.", "warning");
  }

  ctx.ui.setWorkingMessage?.(`Pushing ${name}…`);
  try {
    await runRemoteGit(cwd, ["push", "--set-upstream", "--no-mirror", "--no-follow-tags", "--recurse-submodules=no",
      `--force-with-lease=${ref}:`, "--", upstream.remote, `${ref}:${ref}`]);
  } catch {
    ctx.ui.notify("Could not confirm the push. Check remote access and whether the branch name already exists. Your commits are safe on the local branch.", "warning");
    return;
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
  ctx.ui.notify(`Pushed ${name} to ${upstream.remote}.`, "info");
  if (draft && repository) {
    const { handlePrCommand } = await import("./pr-runner.js");
    await handlePrCommand(base, ctx, pi, { baseRef: upstream.tracking, headBranch: name, repository });
  }
}

async function moveCommits(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  const { cwd } = ctx;
  const status = await readGitStatus(cwd);
  if (status.detached || status.unborn || dirty(status) || (await readMenuContext(cwd)).operation !== false) {
    return ctx.ui.notify("Moving commits requires a clean branch with no Git operation in progress.", "warning");
  }
  const upstream = await currentUpstream(cwd);
  if (!upstream || upstream.source !== `refs/heads/${status.branch}`) {
    return ctx.ui.notify("This branch needs a remote-tracking upstream.", "warning");
  }

  const name = await inputBranchName(ctx);
  if (!name) return;
  const blocked = mutationBlocker(ctx);
  if (blocked) return ctx.ui.notify(blocked, "warning");

  // Fetch just the tracked branch, never merging, pushing, or pruning anything.
  const trackingName = upstream.tracking.slice("refs/remotes/".length);
  ctx.ui.setWorkingMessage?.(`Refreshing ${trackingName}…`);
  try {
    await runRemoteGit(cwd, ["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--no-recurse-submodules", "--no-auto-maintenance",
      "--no-write-fetch-head", "--refmap=", "--", upstream.remote, `+${upstream.target}:${upstream.tracking}`]);
  } catch {
    ctx.ui.notify("Could not refresh the upstream. No local branch was moved.", "warning");
    return;
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
  if (!sameUpstream(upstream, await currentUpstream(cwd))) {
    return ctx.ui.notify("The current branch or upstream changed. Nothing was moved.", "warning");
  }
  const base = await readCommit(cwd, upstream.tracking);
  const range = `${base}..${upstream.head}`;
  const ancestor = await execGit(["merge-base", "--is-ancestor", base, upstream.head], cwd).then(() => true, () => false);
  if (!ancestor || base === upstream.head) {
    return ctx.ui.notify("The current branch is no longer strictly ahead of its upstream. Nothing was moved.", "warning");
  }
  const [count, preview] = await Promise.all([
    execGit(["rev-list", "--count", range], cwd).then(Number),
    execGit(["log", "--format=%h %s", "--no-notes", "--no-show-signature", "-n", "25", range], cwd),
  ]);
  if (!await confirmGitReview(ctx, "Move unpushed commits to a new branch", [
    `${name} → ${upstream.head.slice(0, 12)} (create and switch)`,
    `${status.branch} → ${trackingName} at ${base.slice(0, 12)} (local branch only)`,
    "No commits will be pushed by this step.", "", `${count} commit${count === 1 ? "" : "s"}:`, preview.trimEnd(),
    ...(count > 25 ? [`…and ${count - 25} earlier commits.`] : []),
  ], "Move commits")) return;

  ctx.ui.setWorkingMessage?.("Rechecking the branch and upstream…");
  const remoteTip = await remoteCommit(cwd, upstream).finally(() => ctx.ui.setWorkingMessage?.());
  const [freshStatus, local, freshUpstream, trackingTip] = await Promise.all([
    readGitStatus(cwd), readMenuContext(cwd), currentUpstream(cwd), readCommit(cwd, upstream.tracking),
  ]);
  const nowBlocked = mutationBlocker(ctx);
  if (nowBlocked) return ctx.ui.notify(nowBlocked, "warning");
  if (remoteTip !== base || trackingTip !== base || !sameUpstream(upstream, freshUpstream) || freshStatus.branch !== status.branch ||
      dirty(freshStatus) || local.operation !== false) {
    return ctx.ui.notify("The branch, working tree, or verified upstream changed since the preview. Nothing was moved.", "warning");
  }

  // Preserve the exact reviewed commit first. A failed ref update leaves both branches intact.
  await execGit(["switch", "--no-recurse-submodules", "--no-track", "-c", name, upstream.head], cwd);
  try {
    const [where, worktrees, featureTip] = await Promise.all([
      execGit(["symbolic-ref", "HEAD"], cwd), execGit(["worktree", "list", "--porcelain", "-z"], cwd),
      readCommit(cwd, `refs/heads/${name}`),
    ]);
    if (where.trimEnd() !== `refs/heads/${name}` || featureTip !== upstream.head ||
        worktrees.split("\0").includes(`branch ${upstream.source}`)) throw new Error("Worktree or branch changed");
    await execGit(["update-ref", "--no-deref", "-m", "pi-enhanced: move unpushed commits", upstream.source, base, upstream.head], cwd);
  } catch {
    ctx.ui.notify(`Created ${name}, but did not move ${status.branch}. Verify the branch positions before retrying.`, "warning");
    return;
  }
  ctx.ui.notify(`Moved ${count} commit${count === 1 ? "" : "s"} to ${name}. ${status.branch} now matches ${trackingName}.`, "info");
  await offerPush(ctx, pi, upstream, name);
}

export async function handleBranchesMenu(ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
  if (!ctx.hasUI) return;
  const { cwd } = ctx;
  if (!await isGitRepository(cwd)) return ctx.ui.notify("Current directory is not inside a Git repository.", "warning");
  try {
    const [status, local] = await Promise.all([readGitStatus(cwd), readMenuContext(cwd)]);
    const blocked = mutationBlocker(ctx);
    const busy = local.operation === false ? undefined : "Finish the current Git operation first.";
    const unavailable = blocked ?? busy;
    const canCreate = unavailable ?? (status.unborn ? "Create the first commit first." : undefined);
    const actions: GitMenuAction[] = [
      ["Switch branch", "switch", unavailable],
      ["Create branch here", "create", canCreate],
    ];
    if ((status.ahead ?? 0) > 0) {
      actions.push(["Move unpushed commits to a new branch", "move", canCreate ??
        (status.behind !== 0 ? "The branch must be strictly ahead of its upstream." : undefined) ??
        (dirty(status) ? "Clean the working tree first." : undefined)]);
    }
    const current = status.detached ? `Detached HEAD (${status.branch})` : status.branch;
    const rows: [string, string][] = [["Current", current]];
    if (status.upstream) rows.push(["Upstream", status.ahead === undefined ? status.upstream :
      `${status.upstream} · ${status.ahead} ahead, ${status.behind} behind (local)`]);
    const choice = await selectGitMenu(ctx, "Branches", rows, actions);
    if (!choice) return;
    const nowBlocked = mutationBlocker(ctx);
    if (nowBlocked) return ctx.ui.notify(nowBlocked, "warning");
    if (choice === "switch") await pickLocalBranch(ctx, status.detached ? "" : status.branch, "Switch branch");
    else if (choice === "move") await moveCommits(ctx, pi);
    else if (choice === "create") {
      const suggestionBlocker = !ctx.model ? "Select a model first" : !status.staged && !status.unstaged ? "No tracked changes" : undefined;
      const name = await promptCreateBranch(ctx, current, suggestionBlocker);
      if (!name) return;
      const blocked = mutationBlocker(ctx);
      if (blocked) return ctx.ui.notify(blocked, "warning");
      await execGit(["switch", "--no-recurse-submodules", "-c", name], cwd);
      ctx.ui.notify(`Created and switched to '${name}'.`, "info");
    }
  } catch {
    ctx.ui.notify("Could not complete the branch action. Check Git Status before retrying.", "warning");
  }
}
