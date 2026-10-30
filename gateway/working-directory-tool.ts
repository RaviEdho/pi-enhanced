import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { accessSync, constants, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Type } from "typebox";

const Parameters = Type.Object({
  path: Type.String({ minLength: 1, description: "Existing project directory. Absolute paths, ~/, and paths relative to the current session cwd are supported." }),
  reason: Type.Optional(Type.String({ maxLength: 500, description: "Why this directory is the right workspace for the user's task." })),
});

export function createWorkingDirectoryTool(): ToolDefinition<typeof Parameters> {
  return {
    name: "set_working_directory",
    label: "Set session working directory",
    description: "Switch this Discord conversation's actual Pi workspace, preserving history. Use when the task belongs to a different project so relative tools, project instructions, and /commit target that project. Call this tool alone. The gateway switches after the current run settles and automatically resumes the task in the new directory. Does not change other conversations or the gateway default. Does not create directories.",
    parameters: Parameters,
    executionMode: "sequential",
    exposure: "model-only",
    async execute(id, params, signal, _onUpdate, ctx) {
      const requestPath = process.env.PI_ENHANCED_DISCORD_CWD_REQUEST_PATH;
      const token = process.env.PI_ENHANCED_DISCORD_CWD_TOKEN;
      if (process.env.PI_ENHANCED_DISCORD_GATEWAY_CHILD !== "1" || !requestPath || !token) {
        throw new Error("Working-directory switching is only available in an updated Discord gateway session.");
      }
      if (signal?.aborted) throw new Error("Working-directory switch cancelled.");
      const assistant = (ctx.sessionManager.getBranch?.() ?? []).flatMap((entry) =>
        entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []
      ).at(-1);
      const calls = assistant?.content.filter((block) => block.type === "toolCall") ?? [];
      if (calls.some((call) => call.id === id) && calls.length > 1) {
        throw new Error("Call set_working_directory alone, not in a batch with other tools. No switch was scheduled.");
      }
      const input = params.path.trim();
      if (!input || input.includes("\0")) throw new Error("Provide a valid existing directory.");
      const expanded = input === "~" ? homedir() : input.startsWith("~/") ? resolve(homedir(), input.slice(2)) : input;
      const cwd = realpathSync(resolve(ctx.cwd, expanded));
      if (!statSync(cwd).isDirectory()) throw new Error("The requested path is not a directory.");
      accessSync(cwd, constants.R_OK | constants.X_OK);
      if (cwd === realpathSync(ctx.cwd)) {
        return { content: [{ type: "text", text: `Already working in ${cwd}.` }], details: { cwd, changed: false } };
      }
      const { jobManager } = await import("../tools/subagent/jobs.js");
      if (jobManager.getRunningJobs().length > 0) {
        throw new Error("Wait for background subagents to finish or cancel them before switching workspaces.");
      }
      if (signal?.aborted) throw new Error("Working-directory switch cancelled.");
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) throw new Error("A saved conversation is required to preserve history while switching directories.");
      // Exclusive creation prevents two calls from replacing each other's request.
      // The gateway reads it only after settlement, never during this write.
      writeFileSync(requestPath, `${JSON.stringify({
        type: "set_working_directory", requestId: randomUUID(), token,
        cwd, previousCwd: ctx.cwd, sessionFile, reason: params.reason?.trim(),
      })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return {
        content: [{ type: "text", text: `Workspace switch scheduled: ${ctx.cwd} → ${cwd}. Stop using tools in the old workspace. The gateway will preserve this conversation, switch the actual session cwd, reload project instructions/tools, and automatically continue the task. The switch is not applied yet.` }],
        details: { cwd, previousCwd: ctx.cwd, pending: true },
        terminate: true,
      };
    },
  };
}
