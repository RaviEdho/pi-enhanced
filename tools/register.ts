import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGitCommands } from "./git/index.js";
import { registerOutputCompressor } from "./compressor/index.js";
import { registerScout } from "./scout/register.js";
import { registerWebSearch } from "./web/index.js";
import { registerSubagent } from "./subagent/index.js";
import { registerFeedbackTools } from "./feedback/index.js";

/** Register capabilities without importing the public re-export surface. */
export function registerTools(pi: ExtensionAPI): void {
  registerGitCommands(pi);
  registerOutputCompressor(pi);
  registerScout(pi);
  registerWebSearch(pi);
  registerSubagent(pi);
  registerFeedbackTools(pi);
}
