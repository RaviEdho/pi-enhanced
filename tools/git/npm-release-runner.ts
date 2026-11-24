import { execFile } from "node:child_process";
import { promisify, stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PlanModeManager } from "../../ux/plan/manager.js";
import { execGit, isGitRepository } from "./git.js";
import { selectReleaseVersion } from "./release-version-selector.js";
import { confirmGitReview } from "./review-dialog.js";

const execFileAsync = promisify(execFile);
const WORKFLOW = "npm-release.yml";
const BRANCH = "main";
const STAGE_CURRENT = "Stage current version";

function githubRepository(remote: string): string | undefined {
  const url = URL.parse(remote.replace(/^git@github\.com:/i, "ssh://git@github.com/"));
  if (!url || url.hostname !== "github.com" || !["https:", "ssh:"].includes(url.protocol) || url.search || url.hash) {
    return undefined;
  }
  const path = url.pathname.replace(/\.git\/?$/, "");
  return /^\/([A-Za-z0-9-]+\/(?!\.{1,2}\/?$)[A-Za-z0-9_.-]+)\/?$/.exec(path)?.[1];
}

async function githubApi(cwd: string, endpoint: string, args: string[] = []): Promise<string> {
  try {
    const { stdout } = await execFileAsync("gh", [
      "api", "--hostname", "github.com", "-H", "X-GitHub-Api-Version: 2026-03-10", endpoint, ...args,
    ], { cwd, timeout: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "" } });
    return stdout.trim();
  } catch (error) {
    const { code, stderr } = error as { code?: string; stderr?: string };
    if (code === "ENOENT") throw new Error("Install the GitHub CLI and sign in with `gh auth login`.");
    // Never forward child-process stderr or command environment to the UI.
    const status = stderr?.match(/\(HTTP (\d{3})\)/)?.[1];
    if (status === "422") throw new Error(`GitHub rejected the dispatch. Make sure ${WORKFLOW} on ${BRANCH} accepts expected_sha.`);
    if (status === "401" || status === "403" || status === "404") {
      throw new Error(`GitHub returned HTTP ${status}. Check gh auth status, repository access, and that ${WORKFLOW} is on ${BRANCH}.`);
    }
    throw new Error("Could not contact GitHub. Check `gh auth status` and your connection.");
  }
}

/** Optionally bump, then dispatch only after review of the exact remote commit. Never approve on npm. */
export async function handleNpmReleaseCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("Releasing to npm requires confirmation in Pi's terminal UI.", "warning");
    return;
  }
  const plan = PlanModeManager.getInstance();
  if (plan.isEnabled()) {
    ctx.ui.notify("Cannot stage an npm release in Plan Mode. Switch with /implement first.", "warning");
    return;
  }
  if (!(await isGitRepository(ctx.cwd))) {
    ctx.ui.notify("Run /git release npm inside a Git repository with a GitHub origin.", "warning");
    return;
  }

  const remote = await execGit(["remote", "get-url", "origin"], ctx.cwd).catch(() => "");
  const repo = githubRepository(remote.trim());
  if (!repo) {
    ctx.ui.notify("The origin remote must point to a GitHub.com repository over HTTPS or SSH.", "warning");
    return;
  }

  // The checked-out commit is the bump base. Staging can still work without a local manifest.
  const current = await execGit(["show", "HEAD:package.json"], ctx.cwd)
    .then(text => (JSON.parse(text) as { version?: unknown } | null)?.version)
    .catch(() => undefined);
  const choice = await selectReleaseVersion(ctx, current, STAGE_CURRENT);
  if (!choice) return;
  let bumpedSha: string | undefined;
  if (choice !== STAGE_CURRENT) {
    const { prepareNpmVersion } = await import("./npm-version-runner.js");
    bumpedSha = await prepareNpmVersion(ctx, choice);
    if (!bumpedSha) return;
  }

  const endpoint = `repos/${repo}`;
  const workflowPage = `https://github.com/${repo}/actions/workflows/${WORKFLOW}`;
  let dispatchAttempted = false;
  ctx.ui.setWorkingMessage?.(`Checking ${repo}:${BRANCH} for an npm release…`);
  try {
    const { sha, message } = JSON.parse(await githubApi(ctx.cwd, `${endpoint}/commits/${BRANCH}`, [
      "--jq", "{sha, message: .commit.message}",
    ])) ?? {};
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error(`Could not resolve the commit SHA for ${BRANCH}.`);
    }
    if (bumpedSha && sha !== bumpedSha) {
      throw new Error(`The pushed version commit is not the current tip of origin/${BRANCH}. No staging was requested. Run /git release npm and choose ${STAGE_CURRENT} when ready.`);
    }
    const firstLine = typeof message === "string" ? message.trim().split(/[\r\n\u2028\u2029]/, 1)[0] ?? "" : "";
    const subject = [...stripVTControlCharacters(firstLine).replace(/[\p{Cc}\p{Bidi_Control}]/gu, "").trim()];
    const commitTitle = subject.length > 140 ? `${subject.slice(0, 139).join("")}…` : subject.join("");

    const [manifest, workflow] = await Promise.all([
      githubApi(ctx.cwd, `${endpoint}/contents/package.json?ref=${sha}`, ["-H", "Accept: application/vnd.github.raw+json"]),
      githubApi(ctx.cwd, `${endpoint}/actions/workflows/${WORKFLOW}`, ["--jq", ".state"]),
    ]);
    if (workflow !== "active") throw new Error(`${WORKFLOW} is not active on GitHub.`);
    const { name, version } = JSON.parse(manifest) ?? {};
    if (typeof name !== "string" || !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(name) ||
        typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
      throw new Error(`package.json on ${BRANCH} is missing a valid npm name or version.`);
    }
    const release = `${name}@${version}`;
    ctx.ui.setWorkingMessage?.();
    const confirmed = await confirmGitReview(ctx, "Stage npm release?", [
      `${release} from ${repo}:${BRANCH}`,
      `Commit: ${commitTitle || "(no subject)"}`,
      `SHA: ${sha}`,
      "Only the remote commit is included. Local and unpushed changes are not included.",
      "This starts GitHub Actions. Publishing still requires separate approval with npm 2FA.",
    ], "Stage release");
    if (!confirmed) return;
    if (plan.isEnabled()) {
      ctx.ui.notify("Cannot stage an npm release in Plan Mode. Switch with /implement first.", "warning");
      return;
    }

    dispatchAttempted = true;
    ctx.ui.setWorkingMessage?.(`Starting ${WORKFLOW} for ${release}…`);
    const response = await githubApi(ctx.cwd, `${endpoint}/actions/workflows/${WORKFLOW}/dispatches`, [
      "--method", "POST", "-f", `ref=${BRANCH}`, "-f", `inputs[expected_sha]=${sha}`,
    ]);
    let runId: unknown;
    try { runId = JSON.parse(response)?.workflow_run_id; } catch { /* A successful dispatch may not return run details. */ }
    const runUrl = typeof runId === "number" && Number.isSafeInteger(runId) && runId > 0
      ? `https://github.com/${repo}/actions/runs/${runId}`
      : workflowPage;
    ctx.ui.notify(`Requested staging for ${release}. Check GitHub Actions before reviewing and approving on npm.\n${runUrl}`, "info");
  } catch (error) {
    const message = error instanceof SyntaxError ? `Could not read release metadata on ${BRANCH}.`
      : error instanceof Error ? error.message : "Unexpected error.";
    const retryHint = dispatchAttempted ? `\nCheck ${workflowPage} before retrying.` : "";
    ctx.ui.notify(`npm release: ${message}${retryHint}`, "error");
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}
