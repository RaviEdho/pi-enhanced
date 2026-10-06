import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommitCommand } from "./commit/index.js";
import { registerOutputCompressor } from "./compressor/index.js";
import { registerScout } from "./scout/index.js";
import { registerWebSearch } from "./web/index.js";

/**
 * Registers all agent capability tools:
 * - Scout code search engine (find, grep, multi_grep, interceptor)
 * - Unified web search & fetch subsystem (web_search, web_fetch)
 * - Autonomous commit sub-agent (/commit)
 * - Terminal output noise compressor (/recall, /gain)
 */
export function registerTools(pi: ExtensionAPI): void {
  registerCommitCommand(pi);
  registerOutputCompressor(pi);
  registerScout(pi);
  registerWebSearch(pi);
}

export { registerCommitCommand } from "./commit/index.js";
export { registerOutputCompressor } from "./compressor/index.js";
export { registerScout } from "./scout/index.js";
export { registerWebSearch } from "./web/index.js";
