import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { analyzeContext } from "./analyzer.js";
import { ContextViewerComponent } from "./component.js";
import { formatContextSummary } from "./format.js";

/**
 * Handles the /context command.
 *
 * In TUI mode, opens an interactive scrollable viewer with live re-analysis and compaction.
 * In CLI or non-TUI environments, outputs a cleanly formatted ANSI summary to stdout.
 */
export async function handleContextCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.hasUI && ctx.mode === "tui") {
    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      return new ContextViewerComponent(tui, theme, kb, () => done(undefined), ctx);
    });
  } else {
    try {
      const analysis = analyzeContext(ctx);
      const text = formatContextSummary(analysis, {
        availableWidth: (typeof process !== "undefined" && process.stdout?.columns) || 85,
      });
      console.log(text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Failed to analyze context usage: ${msg}`);
    }
  }
}
