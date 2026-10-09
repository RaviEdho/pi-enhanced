import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { createDefaultCliTheme, type UsageTheme } from "../usage/format.js";
import type {
  CategoryBreakdown,
  CellSpec,
  ContextAnalysis,
  ContextItem,
  GridCategory,
} from "./types.js";

export const GRID_COLS = 20;
export const GRID_ROWS = 10;
export const GRID_CELLS = GRID_COLS * GRID_ROWS; // Legacy compatibility
export const GRID_GUTTER = "   ";

export const CELL_FILLED = "█";
export const CELL_FILLED_MESSAGES = "█";
export const CELL_FREE = "░";
export const CELL_BUFFER = "▒";

/**
 * Options for formatting context breakdown text.
 */
export interface FormatContextOptions {
  availableWidth?: number;
  theme?: UsageTheme;
}

/**
 * Formats keybinding hints using Pi's native two-tone convention (dim key, muted description, no brackets).
 */
export function formatNativeKeyHint(theme: any, key: string, desc: string): string {
  const dimFn = theme?.dim
    ? (s: string) => theme.dim(s)
    : theme?.fg
    ? (s: string) => theme.fg("dim", s)
    : (s: string) => `\x1b[2m${s}\x1b[22m`;
  const mutedFn = theme?.fg
    ? (s: string) => theme.fg("muted", s)
    : (s: string) => `\x1b[90m${s}\x1b[39m`;
  return `${dimFn(key)}${mutedFn(` ${desc}`)}`;
}

/**
 * Formats a number with comma separators (e.g. 14,200).
 */
export function formatNum(n: number): string {
  return Math.round(n).toLocaleString();
}

/**
 * Formats a token number into a compact lowercase string (e.g. 200k, 1m).
 */
export function formatTokensCompact(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 10_000) {
    const s = (n / 1_000).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}k`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1_000)}k`;
  if (n < 10_000_000) {
    const s = (n / 1_000_000).toFixed(1);
    return `${s.endsWith(".0") ? s.slice(0, -2) : s}m`;
  }
  return `${Math.round(n / 1_000_000)}m`;
}

/**
 * Formats a ratio as a percent string (e.g. "21.1%", "<0.1%", "0%").
 */
export function percentString(part: number, whole: number, fractionDigits = 1): string {
  if (whole <= 0) return "0%";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.05) return "<0.1%";
  return `${pct.toFixed(fractionDigits)}%`;
}

/**
 * Pads or truncates a string to fit exact column width.
 */
export function fitCol(str: string, width: number, alignRight = false): string {
  const vis = visibleWidth(str);
  if (vis > width) {
    return truncateToWidth(str, width, "…");
  }
  const pad = " ".repeat(Math.max(0, width - vis));
  return alignRight ? `${pad}${str}` : `${str}${pad}`;
}

function styleColor(theme: any, colorKey: string, fallbackAnsi: string, text: string): string {
  if (theme?.fg) {
    const res = theme.fg(colorKey, text);
    if (res && res !== text) return res;
  }
  return `${fallbackAnsi}${text}\x1b[39m`;
}

function styleBold(theme: any, text: string): string {
  return theme?.bold ? theme.bold(text) : `\x1b[1m${text}\x1b[22m`;
}

function styleDim(theme: any, text: string): string {
  if (theme?.dim) return theme.dim(text);
  if (theme?.fg) {
    const res = theme.fg("dim", text);
    if (res && res !== text) return res;
  }
  return `\x1b[2m${text}\x1b[22m`;
}

function styleMuted(theme: any, text: string): string {
  if (theme?.fg) {
    const res = theme.fg("muted", text);
    if (res && res !== text) return res;
  }
  return `\x1b[90m${text}\x1b[39m`;
}

/**
 * Legacy stub for backward compatibility.
 */
export function planCells(
  _contextWindow: number,
  _categories: GridCategory[],
  _autoCompactBufferTokens: number
): CellSpec[] {
  return [];
}

/**
 * Renders a clean horizontal progress bar matching Pi's native bar aesthetic.
 */
export function renderProgressBar(
  usedFraction: number,
  width = 24,
  theme?: any
): string {
  const safeWidth = Math.max(8, width);
  const clamped = Math.max(0, Math.min(1, usedFraction));
  const fillChar = "█";
  const emptyChar = "░";

  const filledCount = Math.round(clamped * safeWidth);
  const colorName = clamped >= 0.9 ? "error" : clamped >= 0.7 ? "warning" : "userMessageText";
  const fallbackAnsi = clamped >= 0.9 ? "\x1b[31m" : clamped >= 0.7 ? "\x1b[33m" : "\x1b[32m";

  let bar = "";
  for (let i = 0; i < safeWidth; i++) {
    if (i < filledCount) {
      bar += styleColor(theme, colorName, fallbackAnsi, fillChar);
    } else {
      bar += styleColor(theme, "dim", "\x1b[2m", emptyChar);
    }
  }

  const bracketL = styleColor(theme, "dim", "\x1b[90m", "[");
  const bracketR = styleColor(theme, "dim", "\x1b[90m", "]");
  return `${bracketL}${bar}${bracketR}`;
}

/**
 * Builds clean, native-styled context usage lines.
 * Designed to fit standard terminal heights cleanly without scroll clutter.
 */
export function buildContextLines(
  analysis: ContextAnalysis,
  options: FormatContextOptions = {}
): string[] {
  const theme = options.theme ?? createDefaultCliTheme(true);
  const width = Math.max(40, options.availableWidth ?? 80);

  const lines: string[] = [];

  const systemCat = analysis.categories.find((c) => c.category === "system");
  const toolResultCat = analysis.categories.find((c) => c.category === "tool_result");
  const userCat = analysis.categories.find((c) => c.category === "user");
  const asstCat = analysis.categories.find((c) => c.category === "assistant");
  const compCat = analysis.categories.find((c) => c.category === "compaction");

  const systemTokens = systemCat?.tokens ?? 0;
  const toolTokens = toolResultCat?.tokens ?? 0;
  const userTokens = userCat?.tokens ?? 0;
  const assistantTokens = asstCat?.tokens ?? 0;
  const messagesTokens = userTokens + assistantTokens;
  const compactionTokens = compCat?.tokens ?? 0;

  const remainingTokens = Math.max(0, analysis.contextWindow - analysis.totalTokens);
  const usedFraction = analysis.contextWindow > 0 ? analysis.totalTokens / analysis.contextWindow : 0;
  const usedPctStr = percentString(analysis.totalTokens, analysis.contextWindow);

  // Model & Provider display
  const modelDisplay = analysis.provider && analysis.provider !== "unknown-provider"
    ? `${analysis.provider}/${analysis.modelId}`
    : analysis.modelId;

  // Responsive bar width: 24 on wide screens, 16 on narrow
  const barWidth = width >= 70 ? 24 : 16;
  const bar = renderProgressBar(usedFraction, barWidth, theme);

  const labelWidth = 12;
  const formatLabel = (lbl: string) => styleDim(theme, lbl.padEnd(labelWidth));

  // 1. Overview Section
  // Model row
  lines.push(`  ${formatLabel("Model")}${styleBold(theme, modelDisplay)}`);

  // Usage row: bar + tokens/window (percent)
  const tokensCompact = formatTokensCompact(analysis.contextWindow);
  const usageStats = `${styleBold(theme, formatNum(analysis.totalTokens))} ${styleDim(theme, `/ ${tokensCompact}`)} ${styleMuted(theme, `(${usedPctStr})`)}`;
  lines.push(`  ${formatLabel("Usage")}${bar}  ${usageStats}`);

  // Headroom row
  let headroomNote = "";
  if (analysis.tokensUntilCompaction > 0) {
    const triggerPct = ((analysis.compactionThresholdTokens / analysis.contextWindow) * 100).toFixed(0);
    headroomNote = styleDim(
      theme,
      `(compacts in ${formatTokensCompact(analysis.tokensUntilCompaction)} · at ${triggerPct}%)`
    );
  } else {
    headroomNote = styleColor(theme, "warning", "\x1b[33m", "(compaction threshold reached)");
  }
  lines.push(
    `  ${formatLabel("Headroom")}${styleBold(theme, formatNum(remainingTokens))} ${styleDim(theme, "tokens available")}  ${headroomNote}`
  );

  // Blank line separator
  lines.push("");

  // 2. Breakdown Section Header
  lines.push(`  ${styleBold(theme, "Breakdown")}`);

  // System
  if (systemTokens > 0) {
    const sysPct = percentString(systemTokens, analysis.contextWindow);
    lines.push(
      `  ${formatLabel("System")}${styleBold(theme, formatNum(systemTokens))} ${styleDim(theme, `tokens (${sysPct})`)}`
    );
  }

  // Messages (User + Assistant)
  const userCount = userCat?.count ?? 0;
  const asstCount = asstCat?.count ?? 0;
  const thinkingTok = asstCat?.subTokens?.thinkingTokens ?? 0;
  const msgDetailsParts: string[] = [];
  if (userCount > 0) msgDetailsParts.push(`${userCount} user`);
  if (asstCount > 0) msgDetailsParts.push(`${asstCount} assistant`);
  if (thinkingTok > 0) msgDetailsParts.push(`incl. ${formatTokensCompact(thinkingTok)} thinking`);
  const msgDetails = msgDetailsParts.length > 0 ? `  ${styleDim(theme, `· ${msgDetailsParts.join(", ")}`)}` : "";

  if (messagesTokens > 0) {
    const msgPct = percentString(messagesTokens, analysis.contextWindow);
    lines.push(
      `  ${formatLabel("Messages")}${styleBold(theme, formatNum(messagesTokens))} ${styleDim(theme, `tokens (${msgPct})`)}${msgDetails}`
    );
  } else {
    lines.push(`  ${formatLabel("Messages")}${styleDim(theme, "none")}`);
  }

  // Tools
  const toolPct = percentString(toolTokens, analysis.contextWindow);
  const toolDetailsParts: string[] = [];
  const totalCalls = toolResultCat?.count ?? (toolResultCat?.toolCounts ? Object.values(toolResultCat.toolCounts).reduce((a, b) => a + b, 0) : 0);
  if (totalCalls > 0) {
    toolDetailsParts.push(`${totalCalls} call${totalCalls > 1 ? "s" : ""}`);
  }
  if (toolResultCat?.toolTokens) {
    const sortedTools = Object.entries(toolResultCat.toolTokens).sort((a, b) => b[1] - a[1]);
    const topSummary = sortedTools.slice(0, 3).map(([name, tok]) => `${name}: ${formatTokensCompact(tok)}`).join(", ");
    if (topSummary) {
      toolDetailsParts.push(`(${topSummary})`);
    }
  }
  const toolDetails = toolDetailsParts.length > 0 ? `  ${styleDim(theme, `· ${toolDetailsParts.join(" ")}`)}` : "";

  lines.push(
    `  ${formatLabel("Tools")}${toolTokens > 0 ? `${styleBold(theme, formatNum(toolTokens))} ${styleDim(theme, `tokens (${toolPct})`)}` : styleDim(theme, "none")}${toolDetails}`
  );

  // Compacted
  if (analysis.compaction.compacted) {
    const runs = analysis.compaction.compactionCount;
    const summaryTok = analysis.compaction.summaryTokens;
    const summaryNote = summaryTok ? ` (${formatTokensCompact(summaryTok)} summary)` : "";
    lines.push(
      `  ${formatLabel("Compacted")}${styleBold(theme, `${runs} run${runs > 1 ? "s" : ""}`)}${styleDim(theme, summaryNote)}`
    );
  } else if (compactionTokens > 0) {
    const compPct = percentString(compactionTokens, analysis.contextWindow);
    lines.push(
      `  ${formatLabel("Compacted")}${styleBold(theme, formatNum(compactionTokens))} ${styleDim(theme, `tokens (${compPct})`)}`
    );
  } else {
    lines.push(`  ${formatLabel("Compacted")}${styleDim(theme, "none")}`);
  }

  // Last turn telemetry (single concise row if available)
  if (analysis.lastTurn && (analysis.lastTurn.promptTokens > 0 || analysis.lastTurn.outputTokens > 0)) {
    const lt = analysis.lastTurn;
    const parts: string[] = [];
    if (lt.outputTokens > 0) parts.push(`${formatTokensCompact(lt.outputTokens)} out`);
    if (lt.promptTokens > 0) parts.push(`${formatTokensCompact(lt.promptTokens)} in`);
    if (lt.cacheHitRate > 0) parts.push(`${lt.cacheHitRate.toFixed(0)}% cache hit`);
    if (parts.length > 0) {
      lines.push(`  ${formatLabel("Last turn")}${styleDim(theme, parts.join(" · "))}`);
    }
  }

  return lines;
}

/**
 * Returns plain/ANSI formatted string for non-TUI printing.
 */
export function formatContextSummary(
  analysis: ContextAnalysis,
  options: FormatContextOptions = {}
): string[] | string {
  const lines = buildContextLines(analysis, options);
  return lines.join("\n");
}
