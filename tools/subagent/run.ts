import type { SubagentResult, SubagentRunOptions } from "./types.js";

/** Keep isolated-session setup out of the parent session's startup graph. */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const { runSubagent: run } = await import("./runner.js");
  return run(options);
}
