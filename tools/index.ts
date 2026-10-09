import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGitCommands } from "./git/index.js";
import { registerOutputCompressor } from "./compressor/index.js";
import { registerScout } from "./scout/index.js";
import { registerWebSearch } from "./web/index.js";
import { registerSubagent } from "./subagent/index.js";

/**
 * Registers all agent capability tools:
 * - Scout code search engine (find, grep, multi_grep, interceptor)
 * - Unified web search & fetch subsystem (web_search, web_fetch)
 * - Autonomous Git workflow & commit sub-agent (/git, /commit)
 * - Terminal output noise compressor (/recall, /gain)
 * - Autonomous isolated subagent routine (subagent, /subagent)
 */
export function registerTools(pi: ExtensionAPI): void {
  registerGitCommands(pi);
  registerOutputCompressor(pi);
  registerScout(pi);
  registerWebSearch(pi);
  registerSubagent(pi);
}

export { registerGitCommands, registerCommitCommand } from "./git/index.js";
export { registerOutputCompressor } from "./compressor/index.js";
export { registerScout } from "./scout/index.js";
export { registerWebSearch } from "./web/index.js";
export { registerSubagent, runSubagent, createSubagentToolDefinition, jobManager } from "./subagent/index.js";
