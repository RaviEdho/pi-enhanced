import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveSessionToolState } from "../../ux/settings/session.js";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { createAskUserToolDefinition } from "./tools.js";

const FEEDBACK_TOOL_NAMES = ["ask_user"];
export const FEEDBACK_TOOL_SESSION_ENTRY = "feedback-tool-session-state";

export interface FeedbackSessionState {
  enabled: boolean;
  timestamp: number;
}

let activeSessionEnabled: boolean | undefined = undefined;
let savedPi: ExtensionAPI | undefined = undefined;

/**
 * Returns whether ask_user is active for the current session.
 * Prefers the session-persisted state to protect prompt caches on resumed sessions,
 * falling back to active tools in the session, or the global setting in enhanced-settings.json.
 */
export function isFeedbackToolActive(): boolean {
  if (activeSessionEnabled !== undefined) {
    return activeSessionEnabled;
  }
  if (savedPi) {
    try {
      const active = savedPi.getActiveTools();
      if (active && active.length > 0) {
        return active.includes("ask_user");
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }
  return EnhancedSettingsStore.getInstance().get("feedback.askUser");
}

/**
 * Registers user feedback tools (ask_user) for interactive agent-user dialogs and decisions.
 * Supports session affinity: preserves ask_user on existing sessions to prevent prompt cache busts,
 * while reflecting settings changes in future/new sessions.
 */
export function registerFeedbackTools(pi: ExtensionAPI): void {
  savedPi = pi;
  pi.registerTool(createAskUserToolDefinition());

  const store = EnhancedSettingsStore.getInstance();

  function syncFeedbackTools(enabled?: boolean): void {
    const isEnabled = enabled !== undefined ? enabled : isFeedbackToolActive();
    try {
      const current = pi.getActiveTools();
      if (isEnabled) {
        const toAdd = FEEDBACK_TOOL_NAMES.filter((name) => !current.includes(name));
        if (toAdd.length > 0) {
          pi.setActiveTools([...current, ...toAdd]);
        }
      } else {
        const remaining = current.filter((name) => !FEEDBACK_TOOL_NAMES.includes(name));
        if (remaining.length !== current.length) {
          pi.setActiveTools(remaining);
        }
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }

  // Session lifecycle: restore session-scoped state to protect prompt cache on resumed sessions
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const entries = ctx.sessionManager?.getEntries?.() || [];
    const isEnabled = resolveSessionToolState(entries, "ask_user", store.get("feedback.askUser"));
    activeSessionEnabled = isEnabled;
    syncFeedbackTools(isEnabled);
  });

  // Dynamic setting toggles
  store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "feedback.askUser") {
      const newEnabled = settings["feedback.askUser"];
      activeSessionEnabled = newEnabled;
      syncFeedbackTools(newEnabled);
    }
  });

  // Inject or prune system prompt guidelines and selected tools
  pi.on("before_agent_start", (event) => {
    const isEnabled = isFeedbackToolActive();

    // If disabled: completely prune ask_user from active tools and guidelines
    if (!isEnabled) {
      if (event.systemPromptOptions?.selectedTools) {
        event.systemPromptOptions.selectedTools = event.systemPromptOptions.selectedTools.filter(
          (name) => !FEEDBACK_TOOL_NAMES.includes(name)
        );
      }
      syncFeedbackTools(false);
      return;
    }

    // If enabled: ensure ask_user is declared in selectedTools and guidelines are appended
    if (!event.systemPromptOptions) return;

    if (event.systemPromptOptions.selectedTools) {
      for (const name of FEEDBACK_TOOL_NAMES) {
        if (!event.systemPromptOptions.selectedTools.includes(name)) {
          event.systemPromptOptions.selectedTools.push(name);
        }
      }
    }

    if (!event.systemPromptOptions.promptGuidelines) {
      event.systemPromptOptions.promptGuidelines = [];
    }

    event.systemPromptOptions.promptGuidelines.push(
      "When encountering requirements ambiguity, missing information, or architectural forks, do NOT guess or assume. Use 'ask_user' to gather human feedback. For open-ended questions, ask directly; for forks or design alternatives, provide 3 distinct choices in the 'choices' parameter. Do NOT prefix choices with 'Option 1:', 'Option 2:'; provide direct, clean answer labels (e.g. ['PostgreSQL [recommended]', 'SQLite', 'MongoDB'])."
    );
  });
}

export * from "./types.js";
export * from "./tools.js";
