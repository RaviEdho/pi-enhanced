import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/**
 * Resolves whether a tool suite is active for a session:
 * 1. Honors explicit session override entries (appended when user explicitly toggles inside this session).
 * 2. If the session has existing conversation history, checks if the tool was in the initial toolsAdded.
 *    If it was, preserves it as enabled to guarantee 100% prefix prompt cache hit preservation.
 * 3. In brand new sessions, adopts the user's global setting from enhanced-settings.json.
 */
export function resolveSessionToolState(
  entries: SessionEntry[] | undefined,
  toolIdentifier: string,
  globalDefault: boolean
): boolean {
  if (!entries || entries.length === 0) {
    return globalDefault;
  }

  // 1. Explicit in-session override entry
  const overrideKey = `${toolIdentifier}-session-override`;
  const override: any = [...entries].reverse().find(
    (e: any) => e.type === "custom" && (e.customType === overrideKey || e.name === overrideKey)
  );
  if (override?.data && typeof override.data.enabled === "boolean") {
    return override.data.enabled;
  }

  // 2. Initial system message toolsAdded check
  const firstSystemMessage: any = entries.find(
    (e: any) => e.type === "message" && e.message?.role === "system"
  );

  if (firstSystemMessage?.message?.toolsAdded) {
    const initialNames = firstSystemMessage.message.toolsAdded.map((t: any) => t.name);
    if (initialNames.includes(toolIdentifier)) {
      return true;
    }
    // Also check if tool was added later in session history (e.g. ask_user introduced mid-conversation)
    for (const e of entries) {
      if (e.type === "message" && (e as any).message?.toolsAdded) {
        if ((e as any).message.toolsAdded.some((t: any) => t.name === toolIdentifier)) {
          return true;
        }
      }
    }
    return globalDefault;
  }

  // If session has past turns/messages, preserve existing tools to protect prompt cache
  const hasHistory = entries.some(
    (e: any) =>
      e.type === "message" ||
      e.type === "custom_message" ||
      (e as any).message?.role === "user" ||
      (e as any).message?.role === "assistant" ||
      e.role === "user" ||
      e.role === "assistant"
  );
  if (hasHistory) {
    return true;
  }

  return globalDefault;
}
