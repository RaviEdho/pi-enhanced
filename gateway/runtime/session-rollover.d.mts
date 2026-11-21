export interface SessionRolloverPolicy {
  enabled: boolean;
  timezone: string;
  resetHour: number;
  idleHours: number;
}

export const DEFAULT_SESSION_ROLLOVER: Readonly<SessionRolloverPolicy>;
export function isValidSessionRollover(value: unknown): value is Partial<SessionRolloverPolicy>;
