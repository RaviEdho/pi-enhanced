import { CronExpressionParser } from "cron-parser";
import { DateTime } from "luxon";

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const MAX_DATE = 253402300799999; // Keep timestamps within four-digit years.
const UNITS = { m: MINUTE, h: 60 * MINUTE, d: DAY, w: 7 * DAY };

export class ScheduleError extends Error {}

export function isScheduleTimezone(value) {
  if (typeof value !== "string" || !/^[\w/:+-]{1,80}$/.test(value)) return false;
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}

function validateTimezone(value) {
  if (!isScheduleTimezone(value)) throw new ScheduleError("Use an IANA timezone such as America/New_York or UTC.");
  return value;
}

const ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/i;
const TOMORROW = /^tomorrow (?:at )?(\d{1,2}):(\d{2})$/i;

function parseOneTime(iso, tomorrow, timezone, now, defaultTimezone) {
  const [, day, clock, second = "00", fraction = "", offset] = iso ?? [];
  if (offset !== undefined && timezone !== undefined) throw new ScheduleError("An ISO timestamp already specifies its timezone. Omit the timezone option or remove the timestamp's offset.");
  const zone = offset === undefined ? validateTimezone(timezone ?? defaultTimezone) : undefined;
  let date = day;
  let time = clock;
  if (tomorrow) {
    const today = DateTime.fromMillis(now, { zone });
    // Add a calendar day to the local date, not 24 hours to the current instant.
    date = DateTime.utc(today.year, today.month, today.day).plus({ days: 1 }).toISODate();
    time = `${tomorrow[1].padStart(2, "0")}:${tomorrow[2]}`;
  }
  const wall = `${date}T${time}:${second}.${fraction.padEnd(3, "0")}`;
  const utc = new Date(`${wall}Z`);
  // Date.parse normalizes dates like February 30 and 24:00; don't accept them.
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, -1) !== wall) throw new ScheduleError("Use a valid date and 24-hour clock time.");
  let nextAt;
  if (offset !== undefined) {
    nextAt = Date.parse(`${wall}${offset}`);
    if (!Number.isFinite(nextAt)) throw new ScheduleError("Use a valid UTC offset in the timestamp.");
  } else {
    const local = DateTime.fromISO(wall, { zone });
    if (!local.isValid || local.toISO({ includeOffset: false }) !== wall) throw new ScheduleError("That local time does not exist in the selected timezone. Choose a different time.");
    if (local.getPossibleOffsets().length > 1) throw new ScheduleError("That local time occurs twice in the selected timezone. Use an ISO timestamp with the intended UTC offset.");
    nextAt = local.toMillis();
  }
  if (!isScheduleTimestamp(nextAt) || nextAt <= now) throw new ScheduleError("Schedule the job for a time in the future.");
  return { schedule: { kind: "once", ...(zone !== undefined ? { timezone: zone } : {}) }, nextAt };
}

export const isScheduleTimestamp = (value) => Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE;
const cronField = /^(?:\*|\d{1,2}(?:-\d{1,2})?)(?:\/[1-9]\d?)?(?:,(?:\*|\d{1,2}(?:-\d{1,2})?)(?:\/[1-9]\d?)?)*$/;

export function nextCron(expression, timezone, after) {
  try {
    const next = CronExpressionParser.parse(`0 ${expression}`, { tz: timezone, currentDate: new Date(after) }).next().getTime();
    if (isScheduleTimestamp(next) && next > after) return next;
  } catch { /* don't expose parser errors */ }
  throw new ScheduleError("Invalid cron schedule or no upcoming occurrence.");
}

export function isRecurringSchedule(schedule) {
  if (schedule?.kind === "interval") {
    return Number.isInteger(schedule.ms) && schedule.ms >= MINUTE && schedule.ms <= 365 * DAY && schedule.ms % MINUTE === 0;
  }
  if (schedule?.kind !== "cron" || typeof schedule.expression !== "string" || schedule.expression.length > 120) return false;
  const fields = schedule.expression.split(" ");
  if (fields.length !== 5 || !fields.every((field) => cronField.test(field))) return false;
  return isScheduleTimezone(schedule.timezone);
}

/** Parse one-shot, fixed elapsed intervals, or five-field wall-clock schedules. */
export function parseSchedule(when, timezone, now, defaultTimezone = "UTC") {
  if (typeof when !== "string" || when.length > 120) throw new ScheduleError("Provide a schedule of at most 120 characters.");
  const input = when.trim().replace(/\s+/g, " ");
  const duration = /^(in|every) ([1-9]\d{0,5})([mhdw])$/i.exec(input);
  if (duration) {
    if (timezone !== undefined) throw new ScheduleError("Elapsed durations do not use a timezone.");
    const ms = Number(duration[2]) * UNITS[duration[3].toLowerCase()];
    if (ms > 365 * DAY) throw new ScheduleError("A duration must be between 1 minute and 365 days.");
    const nextAt = now + ms;
    if (!isScheduleTimestamp(nextAt) || nextAt <= now) throw new ScheduleError("Schedule the job for a time in the future.");
    return { schedule: duration[1].toLowerCase() === "every" ? { kind: "interval", ms } : { kind: "once" }, nextAt };
  }
  const iso = ISO_TIMESTAMP.exec(input);
  const tomorrow = TOMORROW.exec(input);
  if (iso || tomorrow) return parseOneTime(iso, tomorrow, timezone, now, defaultTimezone);
  const schedule = { kind: "cron", expression: input, timezone: validateTimezone(timezone ?? defaultTimezone) };
  if (!isRecurringSchedule(schedule)) throw new ScheduleError("Use ‘in 10m’, ‘tomorrow 05:00’, an ISO timestamp, ‘every 15m’, or five-field cron (e.g. 0 9 * * 1-5).");
  return { schedule, nextAt: nextCron(schedule.expression, schedule.timezone, now) };
}

/** Skip a backlog in one step; fixed intervals retain their original phase. */
export function nextAfter(job, now) {
  if (job.schedule.kind === "once") return null;
  if (job.schedule.kind === "cron") return nextCron(job.schedule.expression, job.schedule.timezone, now);
  const { ms } = job.schedule;
  const next = job.nextAt + (Math.floor((now - job.nextAt) / ms) + 1) * ms;
  return isScheduleTimestamp(next) ? next : null;
}
