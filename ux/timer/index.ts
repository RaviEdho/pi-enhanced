import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Formats elapsed seconds into concise duration string:
 * - < 60s: "20s"
 * - >= 60s and < 3600s: "1m 23s"
 * - >= 3600s: "1h 23m 40s"
 */
export function formatWorkingDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safeSeconds / 3600);
  const m = Math.floor((safeSeconds % 3600) / 60);
  const s = safeSeconds % 60;

  if (h > 0) {
    return `${h}h ${m}m ${s}s`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

/**
 * Registers an agent timer hook that updates the working status text
 * above the input box to show elapsed time (e.g. "Working (20s)").
 */
export function registerWorkingTimer(pi: ExtensionAPI): void {
  let timer: NodeJS.Timeout | undefined;
  let startTime = 0;

  const updateMessage = (ctx: ExtensionContext) => {
    if (!ctx.hasUI || !startTime) return;
    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    ctx.ui.setWorkingMessage(`Working (${formatWorkingDuration(elapsedSeconds)})`);
  };

  const startTimer = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!startTime) {
      startTime = Date.now();
    }
    updateMessage(ctx);
    if (!timer) {
      timer = setInterval(() => {
        updateMessage(ctx);
      }, 1000);
      timer.unref?.();
    }
  };

  const stopTimer = (ctx: ExtensionContext) => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    startTime = 0;
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
    }
  };

  pi.on("agent_start", async (_event, ctx) => {
    startTimer(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    startTimer(ctx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    stopTimer(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    stopTimer(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimer(ctx);
  });
}
