import { existsSync } from "node:fs";
import type { GitStatus } from "../../ux/usage/git-status.js";
import { execGit } from "./git.js";
import type { GitMenuAction } from "./review-dialog.js";

interface MenuContext {
  status?: GitStatus;
  origin?: boolean;
  originDefault?: string;
  hasParent?: boolean;
  operation?: boolean;
  hasModel: boolean;
  isTui: boolean;
  npmWorkflow: boolean;
  planMode: boolean;
  trusted: boolean;
}

/** Start with local Git evidence. A failed probe is unknown, not a blocker. */
export async function readMenuContext(cwd: string): Promise<Pick<MenuContext, "origin" | "originDefault" | "hasParent" | "operation">> {
  const localGit = (args: string[]) => execGit(args, cwd, { GIT_NO_LAZY_FETCH: "1" }).catch(() => undefined);
  const markers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_START"];
  const [remotes, originHead, parents, paths] = await Promise.all([
    localGit(["remote"]),
    localGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
    localGit(["rev-list", "--parents", "-n", "1", "HEAD"]),
    localGit(["rev-parse", "--path-format=absolute", ...markers.flatMap(marker => ["--git-path", marker])]),
  ]);
  const origin = remotes?.split(/\r?\n/).includes("origin");
  const originDefault = /^refs\/remotes\/origin\/(.+)$/.exec(originHead?.trimEnd() ?? "")?.[1];
  const hasParent = parents === undefined ? undefined : parents.trim().includes(" ");
  const operation = paths?.split(/\r?\n/).some(path => path && existsSync(path));
  return { origin, originDefault, hasParent, operation };
}

export function gitStatusActions(context: MenuContext): GitMenuAction[] {
  const { status, origin, originDefault, hasParent, operation, hasModel, isTui, npmWorkflow, planMode, trusted } = context;
  const actions: GitMenuAction[] = [];
  const conflicted = status && status.conflicts > 0;
  const staged = status && status.staged > 0;
  const unstaged = status && status.unstaged > 0;
  const untracked = status && status.untracked > 0;
  const changed = staged || unstaged || untracked || conflicted;
  const conflicts = conflicted ? "Resolve conflicts first" : undefined;
  const inProgress = operation ? "Finish the current Git operation" : undefined;
  const noModel = hasModel ? undefined : "Select a model first";
  const needImplement = planMode ? "Switch to Implement Mode" : undefined;
  const detached = status?.detached ? "Switch to a branch" : undefined;
  const unborn = status?.unborn ? "Create the first commit" : undefined;

  if (conflicted) actions.push(["Resolve conflicts", "/git resolve", noModel]);
  if (staged) actions.push(["Summarize staged changes", "/git summary staged", noModel]);
  if (unstaged || untracked) actions.push(["Summarize unstaged and untracked changes", "/git summary unstaged", noModel]);
  if (changed || !status) actions.push(["Commit changes", "/git commit", conflicts ?? noModel]);
  if (staged || conflicted) actions.push(["Unstage all changes", "/git unstage", conflicts]);
  actions.push(["Sync with remote", "/git sync", conflicts ?? inProgress ?? detached ?? unborn ??
    (status && !status.upstream ? "Set an upstream first" : undefined)]);
  if (!status?.unborn) actions.push(["Draft Pull Request", "/git pr", noModel]);
  if (isTui) actions.push(["Review Pull Request", "/git pr review", noModel]);
  actions.push(["Ship release tag", "/git release ship", conflicts ?? inProgress ?? needImplement ??
    (!trusted ? "Trust this project first" : undefined) ?? detached ?? unborn ??
    (origin === false ? "Configure origin first" : undefined) ??
    (status && originDefault && status.branch !== originDefault ? `Switch to ${originDefault} (local origin default)` : undefined) ??
    (changed ? "Clean the working tree first" : undefined)]);
  if (isTui && npmWorkflow) actions.push(["Release to npm", "/git release npm", needImplement ??
    (origin === false ? "Configure a GitHub origin first" : undefined)]);
  actions.push(["Branches", "/git branches"]);
  if (!status?.unborn && hasParent !== false) actions.push(["Undo last commit", "/git undo", conflicts ?? inProgress]);
  if (staged || unstaged || conflicted) actions.push(["Discard uncommitted changes", "/git discard", conflicts ?? inProgress]);
  return actions;
}
