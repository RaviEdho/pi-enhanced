import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { execGit, getConflictFiles, isGitRepository } from "./git.js";
import { CONFLICT_AGENT_SYSTEM_PROMPT } from "./smart-prompts.js";
import {
  createConflictTools,
  type ConflictResolutionProposal,
} from "./smart-tools.js";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Handles autonomous merge conflict resolution.
 */
export async function handleResolveCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd;

  if (!(await isGitRepository(cwd))) {
    ctx.ui.notify("Current directory is not inside a git repository.", "error");
    return;
  }

  const conflictFiles = await getConflictFiles(cwd);
  if (conflictFiles.length === 0) {
    ctx.ui.notify("No git merge conflicts found in the working tree.", "info");
    return;
  }

  const model = ctx.model;
  if (!model) {
    ctx.ui.notify("No active model selected in Pi session.", "error");
    return;
  }

  // Filter specific file if requested via args
  const targetFilter = args.trim();
  const targets = targetFilter
    ? conflictFiles.filter((f) => f.path.includes(targetFilter))
    : conflictFiles;

  if (targets.length === 0) {
    ctx.ui.notify(`No conflicts match pattern "${targetFilter}".`, "warning");
    return;
  }

  ctx.ui.notify(
    `Found ${targets.length} conflicted file(s) (${targets.reduce((acc, t) => acc + t.hunkCount, 0)} conflict hunks). Starting resolution…`,
    "info"
  );

  const resolutions: ConflictResolutionProposal[] = [];
  const tools = createConflictTools(cwd, (res) => {
    resolutions.push(res);
  });

  const sessionManager = SessionManager.inMemory();
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
  });

  const modelRuntime = (ctx.modelRegistry as any)?.runtime;
  const { session } = await createAgentSession({
    cwd,
    agentDir: getAgentDir(),
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRuntime,
    model,
    tools: ["git_conflict_files", "propose_conflict_resolution"],
    customTools: tools,
  });

  ctx.ui.setWorkingMessage?.("Analyzing conflict markers and formulating resolutions…");

  try {
    const fileList = targets.map((t) => t.path).join(", ");
    const promptText =
      `Please analyze and resolve the git conflicts in: ${fileList}. ` +
      `Inspect each file and call propose_conflict_resolution for each file with cleanly reconciled code.\n\n` +
      CONFLICT_AGENT_SYSTEM_PROMPT;

    await session.prompt(promptText);
  } catch (err: any) {
    ctx.ui.notify(`Conflict resolution sub-agent failed: ${err?.message || String(err)}`, "error");
    return;
  } finally {
    try {
      session.dispose();
    } catch {
      // ignore
    }
    ctx.ui.setWorkingMessage?.();
  }

  if (resolutions.length === 0) {
    ctx.ui.notify("No conflict resolutions were proposed.", "warning");
    return;
  }

  // Review resolutions one by one
  for (const res of resolutions) {
    if (ctx.hasUI) {
      const confirm = await ctx.ui.confirm(
        "Confirm Conflict Resolution",
        `Apply resolution for ${res.filePath}?\nExplanation: ${res.explanation}`
      );
      if (!confirm) {
        ctx.ui.notify(`Skipped ${res.filePath}.`, "info");
        continue;
      }
    }

    try {
      const fullPath = path.resolve(cwd, res.filePath);
      await fs.writeFile(fullPath, res.resolvedContent, "utf-8");
      await execGit(["add", "--", res.filePath], cwd);
      ctx.ui.notify(`Resolved and staged: ${res.filePath}`, "info");
    } catch (err: any) {
      ctx.ui.notify(`Failed to write resolution for ${res.filePath}: ${err?.message}`, "error");
    }
  }

  const remaining = await getConflictFiles(cwd);
  if (remaining.length === 0) {
    ctx.ui.notify("All conflicts resolved! You can now run /git commit.", "info");
  } else {
    ctx.ui.notify(`${remaining.length} conflicted file(s) remaining.`, "warning");
  }
}
