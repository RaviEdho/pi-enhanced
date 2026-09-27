/**
 * System directive injected when the user sends a continue shortcut (".").
 * Resumes previous unfinished work without generating conversational chatter,
 * re-summarizing progress, or asking for confirmation.
 */
export const MANUAL_CONTINUE_PROMPT = `<system-notice>
Continue.

MUST resume most recent intent; complete unfinished work.
If interrupted mid-step: resume where stopped.
NEVER pause to summarize progress, re-confirm plan, or ask whether to proceed; continue.
</system-notice>`;
