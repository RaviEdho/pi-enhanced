import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { createAskUserToolDefinition } from "./tools.js";

const FEEDBACK_TOOL_NAMES = ["ask_user"];
export const FEEDBACK_TOOL_SESSION_ENTRY = "feedback-tool-session-state";

export interface FeedbackSessionState {
  enabled: boolean;
  timestamp: number;
}

let activeSessionEnabled: boolean | undefined = undefined;

/**
 * Returns whether ask_user is active for the current session.
 * Prefers the session-persisted state to protect prompt caches on resumed sessions,
 * falling back to the global setting in enhanced-settings.json for new sessions.
 */
export function isFeedbackToolActive(): boolean {
  if (activeSessionEnabled !== undefined) {
    return activeSessionEnabled;
  }
  return EnhancedSettingsStore.getInstance().get("feedback.askUser");
}

/**
 * Registers user feedback tools (ask_user) for interactive agent-user dialogs and decisions.
 * Supports session affinity: preserves ask_user on existing sessions to prevent prompt cache busts,
 * while reflecting settings changes in future/new sessions.
 */
export function registerFeedbackTools(pi: ExtensionAPI): void {
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

  // Initial sync
  syncFeedbackTools();

  // Session lifecycle: restore session-scoped state to protect prompt cache on resumed sessions
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    const entries = ctx.sessionManager?.getEntries?.() || [];

    // 1. Look for explicit persisted session state
    const lastSessionEntry = [...entries]
      .reverse()
      .find(
        (e) =>
          e.type === "custom" &&
          ((e as any).customType === FEEDBACK_TOOL_SESSION_ENTRY ||
            (e as any).name === FEEDBACK_TOOL_SESSION_ENTRY)
      );

    const customEntry = lastSessionEntry as any;
    if (
      customEntry?.data &&
      typeof customEntry.data.enabled === "boolean"
    ) {
      activeSessionEnabled = customEntry.data.enabled;
    } else {
      // 2. Check if this is an existing session with past conversation history
      const hasPriorConversation = entries.some(
        (e: any) =>
          e.type === "message" ||
          e.type === "custom_message" ||
          e.role === "user" ||
          e.role === "assistant"
      );

      if (hasPriorConversation) {
        // Existing session: keep enabled to preserve prefix prompt cache hits!
        activeSessionEnabled = true;
      } else {
        // 3. New session: adopt the user's global setting from enhanced-settings.json
        activeSessionEnabled = store.get("feedback.askUser");
        try {
          pi.appendEntry(FEEDBACK_TOOL_SESSION_ENTRY, {
            enabled: activeSessionEnabled,
            timestamp: Date.now(),
          } satisfies FeedbackSessionState);
        } catch {
          // Ignore if session tree is not yet writable
        }
      }
    }

    syncFeedbackTools(activeSessionEnabled);
  });

  // Dynamic setting toggles
  store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "feedback.askUser") {
      const newEnabled = settings["feedback.askUser"];
      activeSessionEnabled = newEnabled;
      syncFeedbackTools(newEnabled);

      // Persist the explicit change to the active session so future resumes of this session also remember it
      try {
        pi.appendEntry(FEEDBACK_TOOL_SESSION_ENTRY, {
          enabled: newEnabled,
          timestamp: Date.now(),
        } satisfies FeedbackSessionState);
      } catch {
        // Non-fatal
      }
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
