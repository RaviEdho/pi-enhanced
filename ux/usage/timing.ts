/** Fraction of the known window elapsed; unstarted rolling windows have no marker. */
export function computeTimeElapsedFraction(
  resetTimeIso?: string,
  windowSeconds?: number,
  now = Date.now(),
  usedFraction?: number,
): number | undefined {
  if (!resetTimeIso || !windowSeconds || windowSeconds <= 0) return undefined;
  if (usedFraction !== undefined && usedFraction <= 0) return undefined;
  const resetMs = new Date(resetTimeIso).getTime();
  if (!Number.isFinite(resetMs)) return undefined;
  const windowMs = windowSeconds * 1000;
  const remaining = Math.max(0, Math.min(windowMs, resetMs - now));
  return Math.max(0, Math.min(1, (windowMs - remaining) / windowMs));
}
