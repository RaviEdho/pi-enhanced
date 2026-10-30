import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { log, safeErrorName } from "./logging.mjs";
import { writePrivateJson } from "./persistence.mjs";

const THREAD_TITLE_WAIT_MS = 25_000;
const THREAD_TITLE_POLL_MS = 500;

export function createThreadRegistry({ threadsPath }) {
  const threadRegistry = readThreadRegistry();
  const pendingThreadTitleRenames = new Set();

  return {
    get(threadId) {
      return threadRegistry[threadId];
    },
    register(threadId, registration) {
      threadRegistry[threadId] = registration;
      pruneThreadRegistry();
      writeThreadRegistry();
    },
    watchThreadTitle,
  };

  function watchThreadTitle(channel, session) {
    if (
      typeof channel?.isThread !== "function" ||
      !channel.isThread() ||
      typeof channel.setName !== "function" ||
      !threadRegistry[channel.id]?.createdAt ||
      threadRegistry[channel.id]?.generatedTitle ||
      pendingThreadTitleRenames.has(channel.id)
    ) {
      return;
    }

    pendingThreadTitleRenames.add(channel.id);
    void (async () => {
      const deadline = Date.now() + THREAD_TITLE_WAIT_MS;
      while (Date.now() < deadline) {
        if (session.closed) return;
        try {
          const state = await session.request("get_state", {}, 5_000);
          const title = typeof state.data?.sessionName === "string" ? state.data.sessionName.trim() : "";
          if (title) {
            const threadName = Array.from(title).slice(0, 100).join("");
            if (channel.name !== threadName) await channel.setName(threadName);
            const registration = threadRegistry[channel.id];
            if (registration) {
              registration.generatedTitle = threadName;
              writeThreadRegistry();
            }
            log(`Renamed Discord thread ${channel.id} to generated session title`);
            return;
          }
        } catch {
          if (session.closed) return;
        }
        await delay(Math.min(THREAD_TITLE_POLL_MS, Math.max(0, deadline - Date.now())));
      }
    })()
      .catch((error) => {
        log(`Could not rename Discord thread ${channel.id}: ${safeErrorName(error)}`);
      })
      .finally(() => pendingThreadTitleRenames.delete(channel.id));
  }

  function readThreadRegistry() {
    try {
      const value = JSON.parse(readFileSync(threadsPath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }

  function writeThreadRegistry() {
    writePrivateJson(threadsPath, threadRegistry);
  }

  function pruneThreadRegistry() {
    const entries = Object.entries(threadRegistry).sort((a, b) => String(b[1]?.createdAt).localeCompare(String(a[1]?.createdAt)));
    for (const [threadId] of entries.slice(5000)) delete threadRegistry[threadId];
  }
}

/** One session per thread, retaining the starter's legacy persistence key. */
export function getThreadSessionKey(threadId, registration) {
  const key = `guild:${registration.parentChannelId}:thread:${threadId}`;
  // Existing session directories hash this exact key. Pin it to the registered
  // starter, never the current speaker, to resume history/workspace without a copy.
  return registration.createdByUserId ? `${key}:user:${registration.createdByUserId}` : key;
}

export function makeThreadName(username, prompt) {
  const summary = prompt.replace(/\s+/g, " ").trim();
  const name = summary ? `${username}: ${summary}` : `${username}: Pi conversation`;
  return name.slice(0, 95);
}
