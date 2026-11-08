import type { SubagentResult, SubagentRunOptions } from "./types.js";

// Background and synchronous callers must await the same fully initialized runner.
let runnerModulePromise: Promise<typeof import("./runner.js")> | undefined;

/** Keep isolated-session setup out of the parent session's startup graph. */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const { runSubagent: run } = await (runnerModulePromise ??= import("./runner.js").catch((error) => {
    runnerModulePromise = undefined;
    throw error;
  }));
  return run(options);
}
