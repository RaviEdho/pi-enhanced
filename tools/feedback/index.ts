import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskUserToolDefinition } from "./tools.js";

const FEEDBACK_TOOL_NAMES = ["ask_user"];

/**
 * Registers user feedback tools (ask_user) for interactive agent-user dialogs and decisions.
 */
export function registerFeedbackTools(pi: ExtensionAPI): void {
  pi.registerTool(createAskUserToolDefinition());

  function activateFeedbackTools(): void {
    try {
      const current = pi.getActiveTools();
      const toAdd = FEEDBACK_TOOL_NAMES.filter((name) => !current.includes(name));
      if (toAdd.length > 0) {
        pi.setActiveTools([...current, ...toAdd]);
      }
    } catch {
      // Non-fatal if session runner not yet initialized
    }
  }

  activateFeedbackTools();

  pi.on("session_start", async () => {
    activateFeedbackTools();
  });

  // Inject system prompt guidelines nudging the agent to take user feedback
  pi.on("before_agent_start", (event) => {
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
