export const DEFAULT_SESSION_ROLLOVER = Object.freeze({
  enabled: true, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", resetHour: 4, idleHours: 6,
});
const HOUR_MS = 60 * 60 * 1000;

export function isValidSessionRollover(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") return false;
  if (value.resetHour !== undefined && (!Number.isInteger(value.resetHour) || value.resetHour < 0 || value.resetHour > 23)) return false;
  if (value.idleHours !== undefined && (!Number.isInteger(value.idleHours) || value.idleHours < 1 || value.idleHours > 168)) return false;
  if (value.timezone !== undefined) {
    if (typeof value.timezone !== "string" || !value.timezone.trim()) return false;
    try { new Intl.DateTimeFormat("en", { timeZone: value.timezone }); } catch { return false; }
  }
  return true;
}

/** Most recent local daily boundary, independent of the daemon's timezone. */
export function latestSessionBoundary(now, { timezone, resetHour }) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = (time) => Object.fromEntries(formatter.formatToParts(time)
    .filter(({ type }) => type !== "literal").map(({ type, value }) => [type, Number(value)]));
  const local = parts(now);
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day));
  if (local.hour < resetHour) date.setUTCDate(date.getUTCDate() - 1);
  const wallTime = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), resetHour);
  let candidate = wallTime;
  let previous;
  for (let i = 0; i < 6; i += 1) {
    const p = parts(candidate);
    const correction = wallTime - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    if (correction === 0) return candidate;
    const next = candidate + correction;
    // A nonexistent DST hour rolls forward to the first corresponding valid hour.
    if (next === previous) return Math.max(candidate, next);
    previous = candidate;
    candidate = next;
  }
  throw new Error("Could not resolve the session rollover time");
}

export const rolloverSchedule = ({ timezone, resetHour }) => `${timezone}:${resetHour}`;

/** Decide against the boundary, not the current time. A busy night is skipped for the whole day. */
export function advanceSessionRollover(state, policy, boundary, hasWork, rotate) {
  const schedule = rolloverSchedule(policy);
  if (state.schedule !== schedule || !policy.enabled) {
    state.schedule = schedule;
    state.checkedBoundary = boundary;
  } else if (boundary > state.checkedBoundary) {
    // Inclusive cutoff: a request at 10 PM skips a 4 AM / six-hour rollover.
    const quiet = state.lastActivityAt < boundary - policy.idleHours * HOUR_MS;
    const busy = state.pending > 0 || state.lastFinishedAt >= boundary || hasWork();
    if (quiet && !busy) {
      rotate();
      state.lastActivityAt = 0;
      state.lastFinishedAt = 0;
    }
    state.checkedBoundary = boundary;
  }
}
