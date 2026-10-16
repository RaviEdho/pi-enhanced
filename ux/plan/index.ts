import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { PlanModeEditor } from "./editor.js";
import { PlanModeManager } from "./manager.js";

export { PlanModeEditor } from "./editor.js";
export { PlanModeManager } from "./manager.js";
export { PLAN_MODE_DIRECTIVE, IMPLEMENT_MODE_DIRECTIVE } from "./prompt.js";
export { isSafeBashCommand } from "./safe-bash.js";
export type { PlanModeState } from "./types.js";

/**
 * Registers Plan Mode and Implement Mode subsystems:
 * - /plan [prompt]: enter or toggle read-only planning mode
 * - /implement [prompt]: return to implement mode (full write access)
 * - Ctrl+Alt+P and Alt+M shortcuts to toggle mode instantly
 * - Safe read-only sandbox enforcing byte-stable tool schemas for 100% prompt cache hits
 * - Status footer indicator (■ plan / ▶ implement)
 */
export function registerPlanMode(pi: ExtensionAPI): void {
  const manager = PlanModeManager.getInstance();
  manager.init(pi);

  // Register --plan CLI flag
  pi.registerFlag("plan", {
    description: "Start session in plan mode (read-only exploration)",
    type: "boolean",
    default: false,
  });

  // /plan command
  pi.registerCommand("plan", {
    description: "Toggle plan mode (read-only exploration) or submit a planning prompt",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const prompt = args?.trim();
      if (prompt) {
        manager.enable(ctx, true);
        pi.sendUserMessage(prompt);
      } else {
        manager.toggle(ctx);
      }
    },
  });

  // /implement command
  pi.registerCommand("implement", {
    description: "Switch to implement mode (restore write access) or begin execution",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const prompt = args?.trim();
      manager.disable(ctx, true);
      if (prompt) {
        pi.sendUserMessage(prompt);
      }
    },
  });

  // Shortcut toggles: Ctrl+Alt+P and Alt+M
  pi.registerShortcut(Key.ctrlAlt("p"), {
    description: "Toggle plan / implement mode",
    handler: async (ctx: ExtensionContext) => {
      manager.toggle(ctx);
    },
  });

  pi.registerShortcut(Key.alt("m"), {
    description: "Toggle plan / implement mode",
    handler: async (ctx: ExtensionContext) => {
      manager.toggle(ctx);
    },
  });

  // Intercept tool calls to sandbox writes in plan mode
  pi.on("tool_call", async (event: ToolCallEvent): Promise<ToolCallEventResult | undefined> => {
    return manager.checkToolCall(event.toolName, event.input as Record<string, unknown>);
  });

  // Inject plan mode directive at the tail before user prompts
  pi.on(
    "before_agent_start",
    async (_event: BeforeAgentStartEvent): Promise<BeforeAgentStartEventResult | undefined> => {
      if (!manager.isEnabled()) return undefined;

      const directive = manager.getDirective();
      if (!directive) return undefined;

      return {
        message: {
          customType: "plan-mode-directive",
          content: directive,
          display: false,
        },
      };
    }
  );

  // Session lifecycle: install custom editor and restore state
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    if (ctx.hasUI && typeof ctx.ui.setEditorComponent === "function") {
      ctx.ui.setEditorComponent(
        (tui, theme, keybindings) => new PlanModeEditor(tui, theme, keybindings, ctx)
      );
    }

    if (pi.getFlag("plan") === true) {
      manager.enable(ctx, false);
    } else {
      const entries = ctx.sessionManager?.getEntries?.() || [];
      manager.restoreFromSession(entries, ctx);
    }
    manager.updateStatus(ctx);
  });
}
