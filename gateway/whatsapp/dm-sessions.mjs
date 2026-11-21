import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  DEFAULT_SESSION_ROLLOVER, advanceSessionRollover, latestSessionBoundary, rolloverSchedule,
} from "../runtime/session-rollover.mjs";
import { prepareDirectory, readJson, writeJson } from "./storage.mjs";

const SESSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const sessionKeyFor = (baseKey, sessionId) => sessionId === null ? baseKey : `${baseKey}:session:${sessionId}`;

function readState(path) {
  const state = readJson(path, { maxBytes: 4096 });
  if (state === undefined) return undefined;
  if (!state || (state.sessionId !== null && (typeof state.sessionId !== "string" || !SESSION_ID.test(state.sessionId))) ||
      typeof state.schedule !== "string" ||
      ![state.checkedBoundary, state.lastActivityAt, state.lastFinishedAt, state.pending]
        .every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid WhatsApp DM rollover metadata");
  }
  return state;
}

/** Route new DMs to a fresh Pi session after a quiet night; retain old files on disk. */
export function createDmSessionRollover({ sessionRoot, sessions, now = Date.now }) {
  const directory = join(sessionRoot, "dm-rollover");
  prepareDirectory(directory);

  return {
    begin(baseKey, settings, hasPending) {
      const acceptedAt = now();
      const policy = { ...DEFAULT_SESSION_ROLLOVER, ...settings };
      const boundary = latestSessionBoundary(acceptedAt, policy);
      const path = join(directory, `${createHash("sha256").update(baseKey).digest("hex")}.json`);
      const existing = readState(path);
      if (!existing && hasPending) throw new Error("Missing WhatsApp DM rollover metadata for active work");
      const state = existing ?? {
        sessionId: null, schedule: rolloverSchedule(policy), checkedBoundary: boundary,
        lastActivityAt: 0, lastFinishedAt: 0, pending: 0,
      };
      if (!hasPending && state.pending > 0) {
        // A crash (or failed settlement write) left unfinished work. Keep its
        // context on this boundary, just as with a turn that ran past the cutoff.
        state.pending = 0;
        state.lastFinishedAt = acceptedAt;
      }
      const currentKey = sessionKeyFor(baseKey, state.sessionId);
      advanceSessionRollover(state, policy, boundary, () => hasPending || sessions.hasWorkFor(currentKey), () => {
        const sessionId = randomUUID();
        sessions.prepareFresh(sessionKeyFor(baseKey, sessionId), currentKey);
        state.sessionId = sessionId;
      });
      state.lastActivityAt = Math.max(state.lastActivityAt, acceptedAt);
      state.pending += 1;
      // Keep the legacy key until the first rollover. Persist only a session ID,
      // never the linked account identity, sender number, or chat content.
      writeJson(path, state);
      const { sessionId } = state;
      return {
        sessionKey: sessionKeyFor(baseKey, sessionId),
        finish() {
          const latest = readState(path);
          if (!latest || latest.sessionId !== sessionId || latest.pending === 0) throw new Error("Missing WhatsApp DM turn metadata");
          latest.pending -= 1;
          latest.lastFinishedAt = now();
          writeJson(path, latest);
        },
      };
    },
  };
}
