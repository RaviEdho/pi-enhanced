import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnCleanup(path: string): void {
  // Never log credential values or parser errors containing file contents.
  console.warn(`[pi-enhanced] Could not remove retired Hyper data from ${path}; will retry on next load.`);
}

function readJson(path: string): unknown {
  // Match Pi's auth storage, which accepts a leading UTF-8 BOM.
  return JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));
}

function updateJson(path: string, update: (data: Record<string, unknown>) => void): void {
  if (!existsSync(path)) return;
  try {
    const data = readJson(path);
    if (!isRecord(data)) return;
    const before = JSON.stringify(data);
    update(data);
    if (JSON.stringify(data) !== before) {
      const temporaryPath = `${path}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporaryPath, JSON.stringify(data, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
        renameSync(temporaryPath, path);
      } finally {
        rmSync(temporaryPath, { force: true });
      }
    }
  } catch {
    // A malformed or unreadable file must never erase other providers' data.
    warnCleanup(path);
  }
}

/**
 * Idempotent startup migration for the retired Charm Hyper integration.
 * Run before provider registration so account stores never import old credentials.
 * Historical conversations and shell/environment configuration are left alone.
 */
export async function removeRetiredHyperData(
  accountDir = join(homedir(), ".pi/agent"),
  agentDir = getAgentDir()
): Promise<void> {
  // AccountStore historically used the default home directory even when Pi's
  // own credential directory was overridden. Clean both without creating files.
  for (const path of new Set([join(accountDir, "auth.json"), join(agentDir, "auth.json")])) {
    if (!existsSync(path)) continue;
    try {
      const auth = readJson(path);
      if (!isRecord(auth) || !Object.hasOwn(auth, "hyper")) continue;
      // Use Pi's credential API for locked deletion and shared auth-cache invalidation.
      const runtime = await ModelRuntime.create({ authPath: path, modelsPath: null, refreshOnCreate: false });
      await runtime.logout("hyper");
    } catch {
      warnCleanup(path);
    }
  }

  updateJson(join(accountDir, "accounts.json"), (data) => {
    if (Array.isArray(data.accounts)) {
      data.accounts = data.accounts.filter((account) => !isRecord(account) || account.provider !== "hyper");
    }
    if (isRecord(data.activeAccounts)) delete data.activeAccounts.hyper;
    if (isRecord(data.sessionBindings)) {
      for (const binding of Object.values(data.sessionBindings)) {
        if (isRecord(binding)) delete binding.hyper;
      }
    }
  });

  updateJson(join(accountDir, "quota-cache.json"), (data) => {
    for (const [id, entry] of Object.entries(data)) {
      if (id.startsWith("hyper:") ||
        (isRecord(entry) && isRecord(entry.report) && entry.report.providerId === "hyper")) {
        delete data[id];
      }
    }
  });

  const modelsPath = join(accountDir, "hyper-models-cache.json");
  try {
    rmSync(modelsPath, { force: true });
  } catch {
    warnCleanup(modelsPath);
  }
}
