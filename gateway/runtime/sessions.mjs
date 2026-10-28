import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Owns session affinity, per-conversation ordering, and global run slots. */
export function createSessionManager({
  sessionRoot,
  createSession,
  onSessionClosed = () => {},
  maxActiveRuns = 3,
  maxOpenSessions = 20,
  sessionIdleMs = 20 * 60 * 1000,
}) {
  const sessions = new Map();
  const sessionQueues = new Map();
  const runQueue = [];
  let activeRuns = 0;
  let closing = false;
  let closePromise;

  function assertOpen() {
    if (closing) throw new Error("Pi session manager is stopping");
  }

  function enqueue(key, task) {
    if (closing) return Promise.reject(new Error("Pi session manager is stopping"));
    const previous = sessionQueues.get(key) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => {
      assertOpen();
      return task();
    });
    sessionQueues.set(key, current);
    const cleanup = () => {
      if (sessionQueues.get(key) === current) sessionQueues.delete(key);
    };
    current.then(cleanup, cleanup);
    return current;
  }

  async function withRunSlot(task) {
    assertOpen();
    if (activeRuns >= maxActiveRuns) {
      await new Promise((resolve, reject) => runQueue.push({ resolve, reject }));
    } else {
      activeRuns += 1;
    }
    try {
      assertOpen();
      return await task();
    } finally {
      activeRuns -= 1;
      const next = runQueue.shift();
      if (next) {
        activeRuns += 1;
        next.resolve();
      }
    }
  }

  async function stopSession(session) {
    onSessionClosed(session);
    await session.stop();
  }

  async function get(key) {
    assertOpen();
    const session = sessions.get(key);
    if (session && !session.closed) {
      session.lastUsedAt = Date.now();
      return session;
    }
    if (sessions.size >= maxOpenSessions) await closeLeastRecentlyUsedIdleSession();
    assertOpen();
    const hash = createHash("sha256").update(key).digest("hex");
    const sessionDirectory = join(sessionRoot, hash);
    mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    try { chmodSync(sessionDirectory, 0o700); } catch { /* best-effort on non-POSIX filesystems */ }
    const created = createSession(sessionDirectory);
    sessions.set(key, created);
    try {
      await created.start();
      assertOpen();
      return created;
    } catch (error) {
      sessions.delete(key);
      await stopSession(created);
      throw error;
    }
  }

  async function closeLeastRecentlyUsedIdleSession() {
    let candidate;
    for (const [key, session] of sessions) {
      if (!session.running && (!candidate || session.lastUsedAt < candidate.session.lastUsedAt)) {
        candidate = { key, session };
      }
    }
    if (!candidate) return false;
    sessions.delete(candidate.key);
    await stopSession(candidate.session);
    return true;
  }

  async function closeIdle() {
    const now = Date.now();
    for (const [key, session] of sessions) {
      if (!session.running && now - session.lastUsedAt >= sessionIdleMs) {
        sessions.delete(key);
        await stopSession(session);
      }
    }
    while (sessions.size > maxOpenSessions) {
      // All sessions may be busy; wait for the next cleanup rather than spin.
      if (!await closeLeastRecentlyUsedIdleSession()) break;
    }
  }

  return {
    get,
    peek: (key) => sessions.get(key),
    enqueue,
    withRunSlot,
    closeIdle,
    hasWork: () => activeRuns > 0 || sessionQueues.size > 0,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      for (const waiter of runQueue.splice(0)) waiter.reject(new Error("Pi session manager is stopping"));
      closePromise = Promise.all([...sessions.values()].map(stopSession)).then(() => sessions.clear());
      return closePromise;
    },
  };
}
