import { createHash } from "node:crypto";
import { log } from "../runtime/logging.mjs";
import { readConfig, readJson, writeJson } from "./storage.mjs";

const MAX_AGE_SECONDS = 120;
const MAX_RECENT_IDS = 2048;
const MAX_PENDING_RUNS = 32;
const MAX_PENDING_PER_DM = 6;
const MAX_INTAKE = 64;
const MAX_TEXT = 12_000;
const MAX_REPLY = 35_000;
const RUN_TIMEOUT = 8 * 60_000;
// Refresh before the client's transient typing indicator expires.
const TYPING_REFRESH_MS = 4_000;

// Strip only the numeric device component. Do not normalize other JID types
// (groups, broadcasts, hosted/unknown domains) to a routable DM identity.
export function dmJid(value) {
  const match = typeof value === "string" && /^([1-9]\d{0,19})(?::\d+)?@(s\.whatsapp\.net|lid)$/.exec(value);
  if (!match) return undefined;
  const [, id, server] = match;
  if (server === "s.whatsapp.net" && (id.length < 7 || id.length > 15)) return undefined;
  return { id, server, jid: `${id}@${server}` };
}

export async function identifyDm(key, lookupPhone) {
  if (!key || key.fromMe !== false || key.participant || key.participantAlt) return undefined;
  const primary = dmJid(key.remoteJid);
  if (!primary) return undefined;
  const alternate = dmJid(key.remoteJidAlt);
  if (key.remoteJidAlt != null && (!alternate || (alternate.server === primary.server && alternate.id !== primary.id))) return undefined;
  const lid = primary.server === "lid" ? primary : alternate?.server === "lid" ? alternate : undefined;
  const direct = primary.server === "s.whatsapp.net" ? primary : alternate?.server === "s.whatsapp.net" ? alternate : undefined;
  const mapping = lid ? await lookupPhone(lid.jid) : undefined;
  const known = dmJid(mapping);
  if (mapping != null && (known?.server !== "s.whatsapp.net" || (direct && known.id !== direct.id))) return undefined;
  const phone = direct?.id ?? known?.id;
  return phone ? { phone, destination: primary.jid } : undefined;
}

function candidate(message, cutoff, now) {
  const key = message?.key;
  const timestamp = Number(message?.messageTimestamp);
  if (typeof key?.id !== "string" || !key.id || key.id.length > 128 ||
      !Number.isSafeInteger(timestamp) || timestamp <= cutoff || timestamp < now - MAX_AGE_SECONDS || timestamp > now + 10) return undefined;
  const text = message.message?.conversation ?? message.message?.extendedTextMessage?.text;
  if (typeof text !== "string" || !text.trim() || text.length > MAX_TEXT) return undefined;
  return { key, timestamp, text };
}

export function replyParts(text, maxLength = 3500) {
  const parts = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf("\n", maxLength);
    if (cut < maxLength / 2) cut = maxLength;
    if (remaining.charCodeAt(cut - 1) >= 0xd800 && remaining.charCodeAt(cut - 1) <= 0xdbff) cut -= 1;
    parts.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

async function markRead(socket, key) {
  try { await socket.readMessages([key]); }
  catch { /* receipt failures must not delay or fail a Pi turn */ }
}

function startTyping(socket, destination, mayDeliver, isLatest) {
  let stopped = false;
  let inFlight = false;
  let announced = false;
  async function refresh() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      if (!await mayDeliver()) {
        clearInterval(interval);
        return;
      }
      if (stopped) return;
      announced = true;
      await socket.sendPresenceUpdate("composing", destination);
    } catch { /* presence must not delay or fail a Pi turn */ }
    finally { inFlight = false; }
  }
  const interval = setInterval(() => { void refresh(); }, TYPING_REFRESH_MS);
  interval.unref();
  void refresh();
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (!announced) return;
    // Don't await presence on the reply path. An old turn must not clear a
    // newer turn's indicator if the sender recheck takes a while.
    void (async () => {
      if (await mayDeliver() && isLatest()) await socket.sendPresenceUpdate("paused", destination);
    })().catch(() => undefined);
  };
}

export function createDmRouter({ paths, sessions, isCurrent, canAccept, now = () => Math.floor(Date.now() / 1000) }) {
  const stored = readJson(paths.recent, { maxBytes: 256 * 1024 });
  if (stored !== undefined && (!Array.isArray(stored) || stored.length > MAX_RECENT_IDS || stored.some((entry) =>
    !Array.isArray(entry) || !/^[a-f0-9]{64}$/.test(entry[0]) || !Number.isSafeInteger(entry[1])))) {
    throw new Error("Invalid WhatsApp deduplication store");
  }
  const recent = new Map(stored);
  const pending = new Map();
  const typingTurns = new Map();
  let pendingRuns = 0;
  let intake = 0;
  let ordering = Promise.resolve();

  function isAllowed(phone) {
    try { return readConfig(paths.config)?.allowedPhones.includes(phone) === true; }
    catch { return false; }
  }

  async function accept(connection, message) {
    if (!canAccept(connection)) return;
    const entry = candidate(message, connection.liveAfter, now());
    if (!entry) return;
    const resolveAddress = () => identifyDm(entry.key, (jid) => connection.socket.signalRepository.lidMapping.getPNForLID(jid));
    const address = await resolveAddress();
    if (!address || address.phone === connection.account.phone || (connection.account.lid && address.destination === `${connection.account.lid}@lid`) ||
        !canAccept(connection) || !isAllowed(address.phone) || now() - entry.timestamp > MAX_AGE_SECONDS) return;
    const sessionKey = `whatsapp:${connection.account.key}:${address.phone}`;
    if (pendingRuns >= MAX_PENDING_RUNS || (pending.get(sessionKey) ?? 0) >= MAX_PENDING_PER_DM) return;
    // A linked-device replay must never rerun tools, even across a daemon crash.
    const id = createHash("sha256").update(JSON.stringify([sessionKey, entry.key.id])).digest("hex");
    for (const [key, expires] of recent) if (expires < now()) recent.delete(key);
    if (recent.has(id) || recent.size >= MAX_RECENT_IDS) return;
    recent.set(id, entry.timestamp + MAX_AGE_SECONDS);
    try { writeJson(paths.recent, [...recent]); }
    catch {
      recent.delete(id);
      log("WhatsApp could not record an incoming message; ignored it without running Pi.");
      return;
    }

    async function mayDeliver() {
      if (!isCurrent(connection) || !isAllowed(address.phone)) return false;
      try {
        const verified = await resolveAddress();
        return verified?.phone === address.phone && verified.destination === address.destination &&
          isCurrent(connection) && isAllowed(address.phone);
      } catch { return false; }
    }
    const interaction = {
      promptDismissed: false,
      async send(text) {
        for (const part of replyParts(text)) {
          if (!await mayDeliver()) throw new Error("WhatsApp reply destination is no longer active or authorized");
          // Same socket and DM only. Never retry an uncertain send or redirect it
          // to a new connection; avoid link previews/fetches and quoted metadata.
          let timer;
          try {
            const sent = await Promise.race([
              connection.socket.sendMessage(address.destination, { text: part, linkPreview: null }),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("WhatsApp reply timed out")), 20_000);
              }),
            ]);
            if (!sent?.key?.id) throw new Error("WhatsApp did not confirm the reply");
          } finally { clearTimeout(timer); }
        }
      },
    };

    pendingRuns += 1;
    pending.set(sessionKey, (pending.get(sessionKey) ?? 0) + 1);
    void sessions.enqueue(sessionKey, () => sessions.withRunSlot(async () => {
      if (!await mayDeliver() || now() - entry.timestamp > MAX_AGE_SECONDS) return;
      const turn = Symbol();
      typingTurns.set(sessionKey, turn);
      const stopTyping = startTyping(connection.socket, address.destination, mayDeliver,
        () => !typingTurns.has(sessionKey) || typingTurns.get(sessionKey) === turn);
      let reply;
      let timedOut = false;
      let timer;
      try {
        const session = await sessions.get(sessionKey);
        if (!await mayDeliver()) return;
        timer = setTimeout(() => {
          timedOut = true;
          stopTyping();
          void sessions.stopRunning(sessionKey).catch(() => log("WhatsApp could not stop a timed-out Pi turn."));
        }, RUN_TIMEOUT);
        // Baileys respects the linked account's read-receipt privacy setting.
        void markRead(connection.socket, entry.key);
        // Prefix avoids treating arbitrary DM text as a local Pi slash command.
        reply = await session.promptAndWait(`WhatsApp DM from authorized sender ${address.phone}:\n${entry.text}`, interaction);
      } catch {
        log("WhatsApp Pi turn failed.");
        reply = "Pi could not complete this request. Check the gateway status locally.";
      } finally {
        clearTimeout(timer);
        stopTyping();
      }
      const text = timedOut ? "The Pi turn exceeded its time limit and was cancelled." :
        (typeof reply === "string" && reply.trim()) || "Pi returned no text response.";
      const note = interaction.promptDismissed ? "\n\nThis turn requested interactive input, which is unavailable in WhatsApp." : "";
      const trimmed = text.length > MAX_REPLY
        ? text.slice(0, MAX_REPLY).replace(/[\ud800-\udbff]$/, "") + "\n\n[Reply truncated for WhatsApp.]"
        : text;
      await interaction.send(trimmed + note);
    })).catch(() => log("WhatsApp turn was interrupted or its reply could not be delivered.")).finally(() => {
      pendingRuns -= 1;
      const count = pending.get(sessionKey) - 1;
      if (count) pending.set(sessionKey, count);
      else {
        pending.delete(sessionKey);
        typingTurns.delete(sessionKey);
      }
    });
  }

  return {
    receive(connection, event) {
      if (!canAccept(connection) || event?.type !== "notify" || event.requestId != null || !Array.isArray(event.messages)) return;
      for (const message of event.messages) {
        if (intake >= MAX_INTAKE) break;
        intake += 1;
        // LID lookups can be async; preserve arrival order when queueing a DM.
        ordering = ordering.then(() => accept(connection, message)).catch(() => {
          log("Ignored a WhatsApp event whose sender or message could not be verified.");
        }).finally(() => { intake -= 1; });
      }
    },
  };
}
