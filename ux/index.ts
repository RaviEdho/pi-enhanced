import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextCommand } from "./context/index.js";
import { registerContinueShortcut } from "./continue/index.js";
import { registerPlanMode } from "./plan/index.js";
import { registerSettingsEnhancedCommand } from "./settings/index.js";
import { registerAutomaticSessionTitle } from "./session-title.js";
import { registerWorkingTimer } from "./timer/index.js";
import { registerUsageCommand, registerUsageFooter } from "./usage/index.js";

/**
 * Registers all workflow and UX enhancements:
 * - Elapsed working timer on status indicator
 * - "." continue shortcut (bubble-free prompt resume)
 * - Automatic first-message session titles
 * - Safe read-only Plan Mode (/plan, /implement, shortcuts Ctrl+Alt+P / Alt+M)
 * - Provider quota & usage monitor (/usage and live footer bar)
 * - Context window usage & category breakdown (/context)
 * - Extension suite configuration (/settings-enhanced)
 */
export function registerUX(pi: ExtensionAPI): void {
  registerWorkingTimer(pi);
  registerContinueShortcut(pi);
  registerAutomaticSessionTitle(pi);
  registerPlanMode(pi);
  registerUsageCommand(pi);
  registerUsageFooter(pi);
  registerContextCommand(pi);
  registerSettingsEnhancedCommand(pi);
}

export {
  analyzeContext,
  buildContextLines,
  ContextViewerComponent,
  formatContextSummary,
  handleContextCommand,
  registerContextCommand,
  type CategoryBreakdown,
  type CompactionInfo,
  type ContextAnalysis,
  type ContextCategory,
  type ContextItem,
  type LastTurnMetrics,
} from "./context/index.js";
export { registerContinueShortcut } from "./continue/index.js";
export { registerAutomaticSessionTitle } from "./session-title.js";
export {
  PlanModeEditor,
  PlanModeManager,
  registerPlanMode,
  handlePlanApprovalGate,
  hasPlanArtifact,
  isSafeBashCommand,
  PLAN_MODE_DIRECTIVE,
  IMPLEMENT_MODE_DIRECTIVE,
  type PlanModeState,
} from "./plan/index.js";
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
export {
  EnhancedSettingsComponent,
  EnhancedSettingsStore,
  formatEnhancedSettings,
  formatSettingValue,
  handleSettingsEnhancedCommand,
  registerSettingsEnhancedCommand,
  type ContextUsageFormat,
  type EnhancedSettingKey,
  type EnhancedSettings,
  type SettingDefinition,
  type SubagentExecutionMode,
} from "./settings/index.js";
