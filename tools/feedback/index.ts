import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { createAskUserToolDefinition } from "./tools.js";

const FEEDBACK_TOOL_NAMES = ["ask_user"];

/**
 * Registers user feedback tools (ask_user) for interactive agent-user dialogs and decisions.
 * Supports dynamic enabling/disabling via enhanced settings ("feedback.askUser").
 */
export function registerFeedbackTools(pi: ExtensionAPI): void {
  pi.registerTool(createAskUserToolDefinition());

  const store = EnhancedSettingsStore.getInstance();

  function syncFeedbackTools(enabled?: boolean): void {
    const isEnabled = enabled !== undefined ? enabled : store.get("feedback.askUser");
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

  // Re-sync on session start
  pi.on("session_start", async () => {
    syncFeedbackTools();
  });

  // Watch for dynamic setting toggles
  store.onChange((settings, changedKey) => {
    if (!changedKey || changedKey === "feedback.askUser") {
      syncFeedbackTools(settings["feedback.askUser"]);
    }
  });

  // Inject or prune system prompt guidelines and selected tools
  pi.on("before_agent_start", (event) => {
    const isEnabled = store.get("feedback.askUser");

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
