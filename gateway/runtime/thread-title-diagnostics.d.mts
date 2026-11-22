export const THREAD_TITLE_DIAGNOSTIC_KEY: string;

export type ThreadTitleOutcome =
  | "generated" | "auto-title-disabled" | "session-inactive" | "model-unavailable" | "model-lookup-error"
  | "empty-source" | "completion-error" | "completion-aborted" | "output-limit" | "empty-title"
  | "title-already-set" | "save-error";
export type ThreadTitleFailureCause =
  | "timeout" | "rate-limit" | "auth" | "access-denied" | "bad-request" | "provider-unavailable" | "network" | "unknown";

export interface ThreadTitleDiagnostic {
  outcome: ThreadTitleOutcome;
  elapsedMs: number;
  model?: string;
  cause?: ThreadTitleFailureCause;
}

export function threadTitleFailureCause(value: unknown): ThreadTitleFailureCause;
export function threadTitleDiagnostic(outcome: ThreadTitleOutcome, model: string, elapsedMs: number, cause?: ThreadTitleFailureCause): ThreadTitleDiagnostic | undefined;
export function parseThreadTitleDiagnostic(text: unknown): ThreadTitleDiagnostic | undefined;
