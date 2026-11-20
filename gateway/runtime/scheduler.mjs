import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { log, safeErrorName } from "./logging.mjs";
import { writePrivateJson } from "./persistence.mjs";
import { isRecurringSchedule, isScheduleTimestamp, isScheduleTimezone, nextAfter, parseSchedule, ScheduleError } from "./schedule-time.mjs";

export const JOB_TEXT_LIMIT = 1800;
export const snowflake = (id) => typeof id === "string" && /^\d{17,20}$/.test(id);
export const isScheduleDelivery = (value) => ["default", "here", "home", "dm"].includes(value) || snowflake(value);
const jobId = (id) => typeof id === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(id);
const outcomes = new Set(["running", "sent", "completed", "blocked", "failed", "timed out", "access denied", "interrupted"]);
const jobKinds = new Set(["reminder", "agent", "shell"]);
export const scheduleUsesWorkspace = (kind) => kind === "agent" || kind === "shell";
const active = (job) => job.nextAt !== null || job.last?.outcome === "running";
const sameScope = (job, scope) => job.userId === scope.userId && job.channelId === scope.channelId && job.guildId === scope.guildId && job.parentChannelId === scope.parentChannelId;

function validDestination(scope) {
  return snowflake(scope.userId) && snowflake(scope.channelId) && (scope.guildId === null ? scope.parentChannelId === null
    : snowflake(scope.guildId) && snowflake(scope.parentChannelId));
}

function validJobText(kind, text) {
  return typeof text === "string" && text.length <= JOB_TEXT_LIMIT && !!text.trim() && (kind !== "shell" || !text.includes("\0"));
}

function validJob(job) {
  return job && jobId(job.id) && validDestination(job) && jobKinds.has(job.kind) && validJobText(job.kind, job.text) &&
    (!scheduleUsesWorkspace(job.kind) || (typeof job.cwd === "string" && isAbsolute(job.cwd))) &&
    (job.schedule?.kind === "once"
      ? job.schedule.timezone === undefined || isScheduleTimezone(job.schedule.timezone)
      : isRecurringSchedule(job.schedule)) &&
    (job.delivery === undefined || isScheduleDelivery(job.delivery)) &&
    isScheduleTimestamp(job.createdAt) && (job.nextAt === null || isScheduleTimestamp(job.nextAt)) &&
    (job.cancelled === undefined || (job.cancelled === true && job.nextAt === null)) &&
    (job.last === undefined || (job.last && outcomes.has(job.last.outcome) && isScheduleTimestamp(job.last.at)));
}

/** Single-daemon store. Persist a claim before any delivery/tool side effects. */
export function createScheduler({ path, run, withRunSlot, trackTask = (task) => task, canRun, now = Date.now, logger = log }) {
  const unavailable = () => new ScheduleError("Schedule storage is unavailable. Check the gateway logs.");
  let jobs = new Map();
  let readable = true;
  let closed = false;
  let timer;
  let storageError = false;
  const inFlight = new Map();
  try {
    if (statSync(path).size > 8 * 1024 * 1024) throw new Error("Schedule store exceeds its size limit");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 204 || !saved.jobs.every(validJob)) throw new Error("Invalid schedule store");
    for (const job of saved.jobs) {
      if (jobs.has(job.id)) throw new Error("Duplicate job ID");
      if (job.last?.outcome === "running") job.last = { ...job.last, outcome: "interrupted" };
      jobs.set(job.id, job);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      readable = false;
      logger(`Discord schedule storage could not be loaded: ${safeErrorName(error)}`);
    }
  }

  function update(job) {
    const next = new Map(jobs).set(job.id, job);
    // Keep recent terminal rows for diagnostics without growing the store.
    const terminal = [...next.values()].filter((row) => !active(row))
      .sort((a, b) => (b.last?.at ?? b.createdAt) - (a.last?.at ?? a.createdAt));
    for (const expired of terminal.slice(100)) next.delete(expired.id);
    try {
      if (!writePrivateJson(path, { version: 1, jobs: [...next.values()] })) throw new Error("Schedule store replacement failed");
    } catch (error) {
      if (!storageError) logger(`Could not save Discord schedule storage: ${safeErrorName(error)}`);
      storageError = true;
      throw unavailable();
    }
    storageError = false;
    jobs = next;
  }

  function checkScope(scope) {
    if (closed || !readable) throw unavailable();
    if (!validDestination(scope)) throw new ScheduleError("Invalid schedule destination.");
  }

  function prepare(input, defaultTimezone) {
    if (!jobKinds.has(input.kind)) throw new ScheduleError("Choose a reminder, agent, or shell job.");
    if (!validJobText(input.kind, input.text)) throw new ScheduleError(`Provide 1–${JOB_TEXT_LIMIT} characters of reminder text, agent instructions, or a shell command without null characters.`);
    const delivery = input.delivery === undefined ? "default" : input.delivery;
    if (!isScheduleDelivery(delivery)) throw new ScheduleError("Delivery must be default, here, home, dm, or a Discord channel ID.");
    const text = input.kind === "shell" ? input.text : input.text.trim();
    return { ...parseSchedule(input.when, input.timezone, now(), defaultTimezone), kind: input.kind, text, delivery };
  }

  function create(scope, input, cwd, defaultTimezone) {
    checkScope(scope);
    const prepared = prepare(input, defaultTimezone);
    if (scheduleUsesWorkspace(prepared.kind) && (typeof cwd !== "string" || !isAbsolute(cwd))) throw new ScheduleError("The job's workspace is unavailable.");
    const live = [...jobs.values()].filter(active);
    if (live.length >= 100 || live.filter((job) => job.userId === scope.userId).length >= 20) throw new ScheduleError("Active job limit reached (20 per user, 100 for the gateway).");
    const { userId, channelId, guildId, parentChannelId } = scope;
    const job = { id: randomUUID(), userId, channelId, guildId, parentChannelId, ...prepared,
      ...(scheduleUsesWorkspace(prepared.kind) ? { cwd } : {}), createdAt: now() };
    update(job);
    return summary(job);
  }

  function list(scope, page = 1) {
    checkScope(scope);
    if (!Number.isInteger(page) || page < 1 || page > 50) throw new ScheduleError("Page must be between 1 and 50.");
    const visible = [...jobs.values()].filter((job) => sameScope(job, scope))
      .sort((a, b) => Number(active(b)) - Number(active(a)) || (a.nextAt ?? Infinity) - (b.nextAt ?? Infinity) || b.createdAt - a.createdAt);
    return { jobs: visible.slice((page - 1) * 4, page * 4).map(summary), page, pages: Math.ceil(visible.length / 4) };
  }

  function cancel(scope, id) {
    checkScope(scope);
    const job = jobs.get(id);
    if (!job || !sameScope(job, scope) || job.cancelled || !active(job)) throw new ScheduleError("No active job with that ID in this conversation.");
    update({ ...job, nextAt: null, cancelled: true });
    return { id, running: job.last?.outcome === "running" };
  }

  async function execute(id) {
    const job = jobs.get(id);
    const started = now();
    if (closed || !canRun() || job?.nextAt == null || job.nextAt > started) return;
    let nextAt = null;
    try { nextAt = nextAfter(job, started); }
    catch { logger(`Could not advance Discord job ${id}; stopping recurrence after this run.`); }
    update({ ...job, nextAt, last: { at: started, outcome: "running" } });
    let outcome = "failed";
    try { outcome = await run(job); }
    catch (error) { logger(`Discord scheduled job ${id} failed: ${safeErrorName(error)}`); }
    if (closed) return;
    const current = jobs.get(id);
    // Do not accumulate runs while the previous occurrence is still running.
    // Also preserve cancellation applied during this occurrence.
    let upcoming = current.nextAt;
    if (upcoming !== null && upcoming <= now()) {
      try { upcoming = nextAfter(current, now()); } catch { upcoming = null; }
    }
    update({ ...current, nextAt: upcoming, last: { at: started, outcome: outcomes.has(outcome) ? outcome : "failed" } });
  }

  function tick() {
    if (closed || !readable || !canRun()) return;
    const counts = { agent: 0, shell: 0 };
    for (const kind of inFlight.values()) if (scheduleUsesWorkspace(kind)) counts[kind] += 1;
    const due = [...jobs.values()].filter((job) => job.nextAt !== null && job.nextAt <= now() && !inFlight.has(job.id))
      .sort((a, b) => a.nextAt - b.nextAt);
    for (const job of due) {
      if (inFlight.size >= 4) break;
      if (scheduleUsesWorkspace(job.kind)) {
        if (counts[job.kind] >= 2) continue;
        counts[job.kind] += 1;
      }
      inFlight.set(job.id, job.kind);
      const executeJob = () => execute(job.id);
      const task = Promise.resolve().then(() => job.kind === "agent" ? withRunSlot(executeJob) : executeJob())
        .catch(() => undefined).finally(() => inFlight.delete(job.id));
      void trackTask(task);
    }
  }

  return { create, list, cancel, tick,
    start() {
      if (closed || timer) return;
      timer = setInterval(tick, 1000);
      timer.unref();
      tick();
    },
    close() { closed = true; clearInterval(timer); },
  };
}

function summary({ id, kind, text, schedule, nextAt, last, cancelled, delivery = "here" }) {
  // Rows from before configurable delivery keep their original destination.
  const preview = kind === "shell" ? "Command hidden" : text.replace(/\s+/g, " ").slice(0, 72);
  return { id, kind, preview, schedule, nextAt, last, cancelled, delivery };
}
