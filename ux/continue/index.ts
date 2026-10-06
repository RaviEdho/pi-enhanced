import type {
  ExtensionAPI,
  ExtensionContext,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import { MANUAL_CONTINUE_PROMPT } from "./prompt.js";

/**
 * Registers the "." (literal dot) continue shortcut.
 *
 * Intercepts literal dot submissions when the agent is idle and there is
 * preceding conversation history, triggering an invisible continuation turn
 * (custom message with display: false) without leaving any "." or directive
 * bubble in the chat transcript.
 */
export function registerContinueShortcut(pi: ExtensionAPI): void {
  pi.on("input", async (event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> => {
    // Only intercept literal dot "." submissions
    const text = event.text.trim();
    if (text !== ".") {
      return { action: "continue" };
    }

    // Do not intercept if images are attached
    if (event.images && event.images.length > 0) {
      return { action: "continue" };
    }

    // Only intercept when agent is idle (not streaming or compacting)
    if (!ctx.isIdle()) {
      return { action: "continue" };
    }

    // Verify there is an assistant message in the current session to continue from
    const branch = ctx.sessionManager?.getBranch?.() || [];
    const hasPriorAssistantMessage = branch.some(
      (entry) => entry.type === "message" && entry.message.role === "assistant"
    );
    if (!hasPriorAssistantMessage) {
      return { action: "continue" };
    }

    // Dispatch the continuation directive as a hidden custom turn.
    // display: false ensures no user message bubble appears in the TUI transcript.
    // triggerTurn: true starts the agent turn immediately.
    queueMicrotask(() => {
      try {
        pi.sendMessage(
          {
            customType: "continue",
            content: MANUAL_CONTINUE_PROMPT,
            display: false,
          },
          { triggerTurn: true }
        );
      } catch {
        // Ignored if session is shutting down or replaced
      }
    });

    return { action: "handled" };
  });
}
