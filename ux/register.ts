import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerContextCommand } from "./context/register.js";
import { registerContinueShortcut } from "./continue/index.js";
import { registerPlanMode } from "./plan/index.js";
import { registerSettingsEnhancedCommand } from "./settings/register.js";
import { registerAutomaticSessionTitle } from "./session-title.js";
import { registerWorkingTimer } from "./timer/index.js";
import { registerUsageFooter } from "./usage/footer.js";
import { registerUsageCommand } from "./usage/register.js";

/** Startup entry point: avoid the public barrels that re-export command UIs. */
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
