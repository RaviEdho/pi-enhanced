import { keyText, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, Loader } from "@earendil-works/pi-tui";

interface ProgressOptions {
  cancelMessage?: string;
  rpcLines?: (status: string, elapsedMs: number) => string[];
  onCancel?: () => void;
}

/** One native inline spinner in the TUI; RPC clients get status lines, not animation. */
export function startGitProgress(ctx: ExtensionCommandContext, key: string, initialStatus: string, options: ProgressOptions = {}) {
  const controller = new AbortController();
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  const { cancelMessage, rpcLines, onCancel } = options;
  let status = initialStatus;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let detach: (() => void) | undefined;
  let draw = () => {};

  if (ctx.hasUI && ctx.mode === "tui") {
    ctx.ui.setWidget(key, (tui, theme) => {
      const label = () => {
        const cancelKey = cancelMessage && !controller.signal.aborted ? keyText("tui.select.cancel") : "";
        const hint = cancelKey ? `  • ${cancelKey} to cancel` : "";
        return `${theme.fg("muted", status)} ${theme.fg("dim", `(${(elapsed() / 1000).toFixed(1)}s)${hint}`)}`;
      };
      const loader = new Loader(tui, (text) => theme.fg("muted", text), (text) => text, label());
      draw = () => loader.setMessage(label());
      timer = setInterval(draw, 100);
      timer.unref();
      return {
        render: (width) => loader.render(width).slice(1),
        invalidate: () => { draw(); loader.invalidate(); },
        dispose: () => {
          clearInterval(timer);
          draw = () => {};
          loader.stop();
          detach?.();
          detach = undefined;
        },
      };
    });
    detach = ctx.ui.onTerminalInput((data) => {
      const keys = getKeybindings();
      if (cancelMessage && keys.matches(data, "tui.select.cancel")) {
        if (!controller.signal.aborted) {
          status = cancelMessage;
          controller.abort();
          draw();
          onCancel?.();
        }
        return { consume: true };
      }
      if (keys.matches(data, "tui.select.confirm")) return { consume: true };
      return undefined;
    });
  } else if (ctx.hasUI) {
    draw = () => ctx.ui.setWidget(key, rpcLines?.(status, elapsed()) ?? [status]);
    draw();
    if (rpcLines) {
      timer = setInterval(draw, 2000);
      timer.unref();
    }
  }

  return {
    signal: controller.signal,
    elapsedMs: elapsed,
    update(message: string) {
      if (closed || controller.signal.aborted) return;
      status = message;
      draw();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      detach?.();
      detach = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(key, undefined);
    },
  };
}

export async function promptWithGitProgress(
  session: { prompt(text: string): Promise<unknown>; abort(): Promise<unknown> },
  signal: AbortSignal,
  text: string,
): Promise<void> {
  if (signal.aborted) return;
  const abort = () => { void session.abort().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await session.prompt(text);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
