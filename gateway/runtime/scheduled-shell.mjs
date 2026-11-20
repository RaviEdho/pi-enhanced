import { execFile, spawn } from "node:child_process";
import { join } from "node:path";

const windows = process.platform === "win32";

function killProcessGroup(pid) {
  if (!pid) return;
  try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

function stopShell(child) {
  if (!windows) return killProcessGroup(child.pid);
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  return new Promise((resolve) => {
    execFile(join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/T", "/F", "/PID", String(child.pid)], { timeout: 1000, windowsHide: true }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve();
      });
  });
}

/** Run in the captured workspace, with no Pi session or captured command output. */
export function runScheduledShell(command, cwd, { signal, timeoutMs = 10 * 60_000 } = {}) {
  if (signal?.aborted) return Promise.resolve({ outcome: "interrupted" });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [], { cwd, shell: true, stdio: "ignore", detached: !windows, windowsHide: true });
    } catch {
      resolve({ outcome: "failed" });
      return;
    }
    let stopped;
    let cleanup;
    let childError = false;
    const stop = (outcome) => {
      if (stopped) return;
      stopped = outcome;
      cleanup = stopShell(child);
    };
    const abort = () => stop("interrupted");
    const timer = setTimeout(() => stop("timed out"), timeoutMs);
    timer.unref();
    signal?.addEventListener("abort", abort, { once: true });
    // Failed spawn emits error before close. Do not expose error details that may include the command.
    child.on("error", () => { childError = true; });
    child.once("close", async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // On POSIX, stop same-group children even if the command left them in the background.
      if (!stopped && !windows) killProcessGroup(child.pid);
      await cleanup;
      const exitCode = !childError && Number.isInteger(code) ? code : undefined;
      resolve(stopped ? { outcome: stopped }
        : { outcome: exitCode === 0 ? "completed" : "failed", ...(exitCode === undefined ? {} : { code: exitCode }) });
    });
  });
}
