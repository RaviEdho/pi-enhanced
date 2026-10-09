/**
 * Context breakdown and analysis type definitions for the /context command.
 */

export type ContextCategory = "system" | "user" | "assistant" | "tool_result" | "compaction";

export interface ContextItem {
  id: string;
  category: ContextCategory;
  label: string;
  preview: string;
  tokens: number;
  percentage: number;
  subType?: string; // e.g. tool name ("bash", "read", "grep")
  isError?: boolean;
}

export interface CategoryBreakdown {
  category: ContextCategory;
  label: string;
  tokens: number;
  percentage: number;
  count: number;
  toolCounts?: Record<string, number>;
  toolTokens?: Record<string, number>;
  subTokens?: {
    thinkingTokens?: number;
    textTokens?: number;
    toolCallTokens?: number;
  };
}

export interface LastTurnMetrics {
  promptTokens: number;
  cachedTokens: number;
  cacheHitRate: number;
  cacheWriteTokens: number;
  outputTokens: number;
  totalTokens: number;
  stopReason?: string;
  model?: string;
}

export interface CompactionInfo {
  compacted: boolean;
  compactionCount: number;
  tokensBefore?: number;
  summaryTokens?: number;
}

export interface GridCategory {
  id: "systemPrompt" | "toolOutputs" | "messages" | "compaction";
  label: string;
  tokens: number;
  color: string;
  fallbackAnsi: string;
  glyph: string;
}

export interface CellSpec {
  glyph: string;
  color: string;
  fallbackAnsi: string;
}

export interface ContextAnalysis {
  modelId: string;
  provider: string;
  contextWindow: number;
  totalTokens: number;
  percentUsed: number;
  remainingTokens: number;
  reserveTokens: number;
  compactionThresholdTokens: number;
  tokensUntilCompaction: number;
  freeTokens: number;
  autoCompactBufferTokens: number;
  categories: CategoryBreakdown[];
  topConsumers: ContextItem[];
  allConsumers: ContextItem[];
  messageCount: number;
  lastTurn?: LastTurnMetrics;
  compaction: CompactionInfo;
  analyzedAt: number;
}
