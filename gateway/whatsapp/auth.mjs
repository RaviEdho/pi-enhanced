import { BufferJSON, initAuthCreds, proto } from "baileys";
import { PHONE, readJson, writeJson } from "./storage.mjs";

const AUTH_LIMIT = 64 * 1024 * 1024;

function validAccount(account) {
  if (!account || typeof account.phone !== "string" || !PHONE.test(account.phone)) return false;
  if (account.lid !== undefined && (typeof account.lid !== "string" || !/^[1-9]\d{0,19}$/.test(account.lid))) return false;
  return account.key === `pn:${account.phone}` || (account.lid !== undefined && account.key === `lid:${account.lid}`);
}

function readAuth(path) {
  const saved = readJson(path, { maxBytes: AUTH_LIMIT, reviver: BufferJSON.reviver });
  if (saved !== undefined && (saved?.version !== 1 || !Buffer.isBuffer(saved.creds?.noiseKey?.private) ||
      !saved.keys || typeof saved.keys !== "object" || Array.isArray(saved.keys) ||
      (saved.account !== undefined && !validAccount(saved.account)))) {
    throw new Error("Invalid WhatsApp auth store");
  }
  return saved;
}

export function hasSavedLink(path) {
  try { return Boolean(readAuth(path)?.account); }
  catch { return false; }
}

// The daemon lock gives this file one writer. Keep all Signal key updates in
// one atomic transaction, including new key types introduced by Baileys.
export function openAuthStore(path, onError) {
  const saved = readAuth(path);
  const creds = saved?.creds ?? initAuthCreds();
  let keys = Object.assign(Object.create(null), saved?.keys);
  let account = saved?.account;
  function save(nextKeys, nextAccount) {
    try {
      writeJson(path, { version: 1, creds, keys: nextKeys, account: nextAccount }, { replacer: BufferJSON.replacer, maxBytes: AUTH_LIMIT });
    } catch (error) {
      onError();
      throw error;
    }
    keys = nextKeys;
    account = nextAccount;
  }
  return {
    get account() { return account; },
    bindAccount(identity) { save(keys, identity); },
    saveCreds(update) {
      // Baileys also merges these updates into the same creds object.
      Object.assign(creds, update);
      save(keys, account);
    },
    state: {
      creds,
      keys: {
        async get(type, ids) {
          const group = keys[type];
          const result = Object.create(null);
          for (const id of ids) {
            if (!group || !Object.hasOwn(group, id)) continue;
            const value = group[id];
            result[id] = type === "app-state-sync-key" ? proto.Message.AppStateSyncKeyData.fromObject(value) : value;
          }
          return result;
        },
        async set(data) {
          const next = Object.assign(Object.create(null), keys);
          for (const [type, updates] of Object.entries(data)) {
            const group = Object.assign(Object.create(null), keys[type]);
            for (const [id, value] of Object.entries(updates)) {
              if (value == null) delete group[id];
              else group[id] = value;
            }
            next[type] = group;
          }
          save(next, account);
        },
      },
    },
  };
}
