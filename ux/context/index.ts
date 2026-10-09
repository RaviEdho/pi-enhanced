import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export { analyzeContext } from "./analyzer.js";
export { handleContextCommand } from "./command.js";
export { ContextViewerComponent } from "./component.js";
export {
  buildContextLines,
  formatContextSummary,
  planCells,
  formatTokensCompact,
  percentString,
  GRID_COLS,
  GRID_ROWS,
  GRID_CELLS,
  GRID_GUTTER,
  CELL_FILLED,
  CELL_FILLED_MESSAGES,
  CELL_FREE,
  CELL_BUFFER,
} from "./format.js";
export type {
  CategoryBreakdown,
  CompactionInfo,
  ContextAnalysis,
  ContextCategory,
  ContextItem,
  LastTurnMetrics,
  GridCategory,
  CellSpec,
} from "./types.js";

/**
 * Registers the /context command with Pi using lazy loading.
 */
export function registerContextCommand(pi: ExtensionAPI): void {
  pi.registerCommand("context", {
    description: "Display active context window usage, category breakdown, and top consumers",
    handler: async (_args, ctx) => {
      const { handleContextCommand } = await import("./command.js");
      await handleContextCommand(ctx);
    },
  });
}
