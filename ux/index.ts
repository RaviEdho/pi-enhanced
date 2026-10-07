import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContinueShortcut } from "./continue/index.js";
import { registerWorkingTimer } from "./timer/index.js";
import { registerUsageCommand, registerUsageFooter } from "./usage/index.js";

/**
 * Registers all workflow and UX enhancements:
 * - Elapsed working timer on status indicator
 * - "." continue shortcut (bubble-free prompt resume)
 * - Provider quota & usage monitor (/usage and live footer bar)
 */
export function registerUX(pi: ExtensionAPI): void {
  registerWorkingTimer(pi);
  registerContinueShortcut(pi);
  registerUsageCommand(pi);
  registerUsageFooter(pi);
}

export { registerContinueShortcut } from "./continue/index.js";
export {
  buildTurnSummary,
  buildWorkingMessage,
  formatLatency,
  formatTokenCount,
  formatTokenRate,
  formatTurnSummary,
  formatWorkingDuration,
  registerTurnSummaryRenderer,
  registerWorkingTimer,
  TURN_SUMMARY_ENTRY_TYPE,
  type RunMetrics,
  type TurnSummary,
} from "./timer/index.js";
export { registerUsageCommand, registerUsageFooter } from "./usage/index.js";
