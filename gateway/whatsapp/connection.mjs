import makeWASocket, { Browsers, DisconnectReason } from "baileys";
import { dmJid } from "./dms.mjs";

// Baileys can log raw stanzas, auth data, identifiers and message text. Only
// the daemon's own fixed status summaries may reach the detached log.
const noop = () => {};
const silentLogger = { level: "silent", child: () => silentLogger, trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };

export function createWhatsAppConnection({ auth, pairing, report, finishPairing, showQr, receive, fail, makeSocket = makeWASocket }) {
  let current;
  let retry;
  let stopped = false;
  let attempts = 0;

  function error(state, reason) {
    if (stopped) return;
    close();
    fail(state, reason);
  }

  function maybeReady(link) {
    if (link.liveAfter !== undefined || !link.open || !link.synced) return;
    const me = auth.state.creds.me;
    const pn = dmJid(me?.id);
    const lid = dmJid(me?.lid);
    if (pn?.server !== "s.whatsapp.net" || (lid && lid.server !== "lid")) {
      error("failed", "Could not verify the linked WhatsApp account.");
      return;
    }
    const previous = auth.account;
    if (previous && (previous.phone !== pn.id || (previous.lid && lid && previous.lid !== lid.id) ||
        (previous.key !== `pn:${pn.id}` && previous.key !== `lid:${previous.lid}`))) {
      error("needs-pairing", "Linked account changed. Re-pair from the local Pi terminal.");
      return;
    }
    link.account = { phone: pn.id, lid: lid?.id ?? previous?.lid, key: previous?.key ?? (lid ? `lid:${lid.id}` : `pn:${pn.id}`) };
    if (!previous || previous.lid !== link.account.lid) auth.bindAccount(link.account);
    // Baileys flushes buffered offline notifications before marking sync done.
    // Also reject timestamps up to (and including) the current second so old
    // data cannot become instructions merely by arriving as a notify event.
    link.liveAfter = Math.floor(Date.now() / 1000);
    attempts = 0;
    report("ready");
    if (pairing) {
      pairing = false;
      finishPairing();
    }
  }

  function connect() {
    if (stopped) return;
    try {
      report("connecting");
      const socket = makeSocket({
        auth: auth.state, browser: Browsers.ubuntu("Pi Gateway"), logger: silentLogger,
        printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false,
        shouldSyncHistoryMessage: () => false, getMessage: async () => undefined,
        connectTimeoutMs: 20_000, defaultQueryTimeoutMs: 12_000,
      });
      const link = { socket };
      current = link;
      socket.ev.on("creds.update", (update) => {
        if (current !== link) return;
        try { auth.saveCreds(update); }
        catch { error("failed", "Could not safely save WhatsApp credentials."); }
      });
      socket.ev.on("messages.upsert", (event) => receive(link, event));
      socket.ev.on("connection.update", (update) => {
        if (current !== link || stopped) return;
        try {
          if (update.qr) {
            if (!pairing) {
              error("needs-pairing", "Run /whatsapp setup to pair from the local terminal.");
              return;
            }
            report("pairing");
            showQr(update.qr);
          }
          if (update.isNewLogin || update.connection === "open") showQr(undefined);
          if (update.connection === "open") {
            link.open = true;
            report("syncing");
            // Don't wait indefinitely for an offline-sync marker if WhatsApp
            // leaves the socket open without completing its initial backlog.
            link.syncTimer = setTimeout(() => {
              if (current === link && link.liveAfter === undefined) {
                void socket.end(new Error("WhatsApp initial sync timed out"));
              }
            }, 30_000);
          }
          if (update.receivedPendingNotifications === true) link.synced = true;
          if (update.connection === "close") {
            clearTimeout(link.syncTimer);
            current = undefined;
            showQr(undefined);
            const code = update.lastDisconnect?.error?.output?.statusCode;
            if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.multideviceMismatch].includes(code)) {
              error("needs-pairing", "WhatsApp rejected or revoked the link. Run /whatsapp setup to pair again.");
            } else if ([DisconnectReason.connectionReplaced, DisconnectReason.forbidden].includes(code)) {
              error("failed", "WhatsApp replaced or blocked the connection. Check Linked Devices before restarting.");
            } else {
              report("disconnected", "WhatsApp disconnected; reconnecting.");
              const wait = code === DisconnectReason.restartRequired && attempts === 0 ? 250 : Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
              attempts += 1;
              retry = setTimeout(connect, wait);
            }
            return;
          }
          maybeReady(link);
          if (link.liveAfter !== undefined) clearTimeout(link.syncTimer);
        } catch {
          error("failed", "Could not initialize the WhatsApp connection safely.");
        }
      });
    } catch {
      error("failed", "Could not initialize Baileys. Check the installed Node.js version and gateway dependencies.");
    }
  }

  function close() {
    if (stopped) return;
    stopped = true;
    clearTimeout(retry);
    clearTimeout(current?.syncTimer);
    const socket = current?.socket;
    current = undefined;
    if (socket) {
      try { void Promise.resolve(socket.end(undefined)).catch(noop); }
      catch { /* shutdown can continue even if the socket is already closed */ }
    }
  }

  return {
    start: connect,
    close,
    isLive: (link) => !stopped && current === link && link.liveAfter !== undefined,
  };
}
