import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import type {
  CategoryBreakdown,
  CompactionInfo,
  ContextAnalysis,
  ContextItem,
  LastTurnMetrics,
} from "./types.js";

const DEFAULT_RESERVE_TOKENS = 16384;
const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Extracts a concise single-line preview string from arbitrary message content.
 */
function extractPreview(content: unknown, maxChars = 60): string {
  if (typeof content === "string") {
    const single = content.replace(/\s+/g, " ").trim();
    return single.length > maxChars ? `${single.slice(0, maxChars)}…` : single;
  }

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object") {
        if ("text" in block && typeof block.text === "string") {
          parts.push(block.text);
        } else if ("thinking" in block && typeof block.thinking === "string") {
          parts.push(block.thinking);
        } else if ("type" in block && block.type === "image") {
          parts.push("[Image]");
        } else if ("name" in block && typeof block.name === "string") {
          parts.push(`call: ${block.name}`);
        }
      }
    }
    const merged = parts.join(" ").replace(/\s+/g, " ").trim();
    return merged.length > maxChars ? `${merged.slice(0, maxChars)}…` : merged;
  }

  return "";
}

/**
 * Robustly estimates token count for any message or fallback text block.
 */
function safeEstimateTokens(msg: any): number {
  try {
    const tok = estimateTokens(msg);
    if (typeof tok === "number" && !Number.isNaN(tok) && tok >= 0) {
      return tok;
    }
  } catch {
    // Fallback chars / 4
  }

  if (typeof msg === "string") {
    return Math.ceil(msg.length / 4);
  }
  if (msg?.content) {
    if (typeof msg.content === "string") {
      return Math.ceil(msg.content.length / 4);
    }
    if (Array.isArray(msg.content)) {
      let chars = 0;
      for (const b of msg.content) {
        if (b?.text) chars += b.text.length;
        if (b?.thinking) chars += b.thinking.length;
        if (b?.arguments) chars += JSON.stringify(b.arguments).length;
        if (b?.type === "image") chars += 4800; // standard 1200 tokens
      }
      return Math.ceil(chars / 4);
    }
  }
  return 0;
}

/**
 * Analyzes active context usage and category breakdown for the current conversation.
 */
export function analyzeContext(ctx: ExtensionContext): ContextAnalysis {
  const model = ctx.model;
  const modelId = model?.id ?? "unknown-model";
  const provider = model?.provider ?? "unknown-provider";

  const usage = ctx.getContextUsage();
  const contextWindow = model?.contextWindow ?? usage?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;

  const projection = ctx.sessionManager.buildSessionProjection();
  const branchEntries = ctx.sessionManager.getBranch();

  // 1. Analyze Compaction History
  const compactionEntries = branchEntries.filter((e) => e.type === "compaction");
  const compacted = compactionEntries.length > 0;
  const latestCompaction: any = compacted ? compactionEntries[compactionEntries.length - 1] : undefined;
  const compaction: CompactionInfo = {
    compacted,
    compactionCount: compactionEntries.length,
    tokensBefore: latestCompaction?.tokensBefore,
    summaryTokens: latestCompaction?.summary ? Math.ceil(latestCompaction.summary.length / 4) : undefined,
  };

  // 2. Track Items & Category Accumulators
  const allItems: ContextItem[] = [];

  let systemTokens = 0;
  let userTokens = 0;
  let assistantTokens = 0;
  let toolTokens = 0;
  let compactionSummaryTokens = 0;

  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;

  const toolCounts: Record<string, number> = {};
  const toolTokensMap: Record<string, number> = {};

  let thinkingTokens = 0;
  let textTokens = 0;
  let toolCallTokens = 0;

  // 3. System Prompt & Instructions
  let hasSystemMessageInProjection = false;
  for (const m of projection.messages) {
    if (m.role === "system") {
      hasSystemMessageInProjection = true;
      break;
    }
  }

  const effectiveSystemPrompt = ctx.getSystemPrompt?.() ?? "";

  if (!hasSystemMessageInProjection && effectiveSystemPrompt.length > 0) {
    const syntheticMsg = { role: "system", content: effectiveSystemPrompt };
    const sysTok = safeEstimateTokens(syntheticMsg);
    systemTokens += sysTok;
    allItems.push({
      id: "system-base",
      category: "system",
      label: "System Prompt & Instructions",
      preview: extractPreview(effectiveSystemPrompt, 65),
      tokens: sysTok,
      percentage: 0,
      subType: "system_prompt",
    });
  }

  // 4. Iterate over Projected Entries & Messages
  for (const entry of projection.entries) {
    const source = entry.sourceEntry;
    const isCompactionSource = source.type === "compaction";

    for (let msgIdx = 0; msgIdx < entry.messages.length; msgIdx++) {
      const msg: any = entry.messages[msgIdx];
      const tok = safeEstimateTokens(msg);
      const itemId = `${source.id}-${msgIdx}`;

      if (msg.role === "system") {
        systemTokens += tok;
        allItems.push({
          id: itemId,
          category: "system",
          label: "System Prompt / Instructions",
          preview: extractPreview(msg.content, 65),
          tokens: tok,
          percentage: 0,
          subType: "system",
        });
      } else if (isCompactionSource || msg.role === "branch_summary") {
        compactionSummaryTokens += tok;
        allItems.push({
          id: itemId,
          category: "compaction",
          label: "Compaction Summary",
          preview: extractPreview(msg.content, 65),
          tokens: tok,
          percentage: 0,
          subType: "summary",
        });
      } else if (msg.role === "user") {
        userTokens += tok;
        userCount++;
        const preview = extractPreview(msg.content, 60);
        allItems.push({
          id: itemId,
          category: "user",
          label: `User Prompt: "${preview}"`,
          preview,
          tokens: tok,
          percentage: 0,
          subType: "user_message",
        });
      } else if (msg.role === "assistant") {
        assistantTokens += tok;
        assistantCount++;

        // Sub-breakdown of assistant content (text vs thinking vs tool calls)
        let msgThinking = 0;
        let msgText = 0;
        let msgCalls = 0;

        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b?.type === "thinking" && b.thinking) {
              const tTok = Math.ceil(b.thinking.length / 4);
              msgThinking += tTok;
            } else if (b?.type === "text" && b.text) {
              const xTok = Math.ceil(b.text.length / 4);
              msgText += xTok;
            } else if (b?.type === "toolCall") {
              const cTok = Math.ceil((b.name.length + JSON.stringify(b.arguments || {}).length) / 4);
              msgCalls += cTok;
            }
          }
        }

        thinkingTokens += msgThinking;
        textTokens += msgText;
        toolCallTokens += msgCalls;

        const preview = extractPreview(msg.content, 60);
        const subLabel = msgThinking > 0 ? ` (incl. ${msgThinking.toLocaleString()} thinking)` : "";
        allItems.push({
          id: itemId,
          category: "assistant",
          label: `Assistant Response${subLabel}`,
          preview,
          tokens: tok,
          percentage: 0,
          subType: msgThinking > 0 ? "thinking" : "assistant_response",
        });
      } else if (msg.role === "toolResult" || msg.role === "custom" || msg.role === "bashExecution") {
        toolTokens += tok;
        toolCount++;
        const toolName = msg.toolName || (msg.role === "bashExecution" ? "bash" : "tool");
        toolCounts[toolName] = (toolCounts[toolName] || 0) + 1;
        toolTokensMap[toolName] = (toolTokensMap[toolName] || 0) + tok;

        const preview = extractPreview(msg.content || msg.output, 60);
        allItems.push({
          id: itemId,
          category: "tool_result",
          label: `Tool [${toolName}] Result: ${preview}`,
          preview,
          tokens: tok,
          percentage: 0,
          subType: toolName,
          isError: !!msg.isError,
        });
      }
    }
  }

  // 5. Total Token Reconciler
  // If Pi's canonical getContextUsage() provides tokens, use that as authoritative total.
  // Otherwise, use our computed estimated total.
  const estimatedSum = systemTokens + userTokens + assistantTokens + toolTokens + compactionSummaryTokens;
  const canonicalTotal = (usage?.tokens !== null && usage?.tokens !== undefined && usage.tokens > 0)
    ? usage.tokens
    : estimatedSum;

  if (canonicalTotal > 0 && estimatedSum > 0 && Math.abs(canonicalTotal - estimatedSum) > 5) {
    const scale = canonicalTotal / estimatedSum;
    systemTokens = Math.round(systemTokens * scale);
    userTokens = Math.round(userTokens * scale);
    assistantTokens = Math.round(assistantTokens * scale);
    toolTokens = Math.round(toolTokens * scale);
    compactionSummaryTokens = Math.round(compactionSummaryTokens * scale);
  }

  const totalTokens = Math.max(0, canonicalTotal);
  const percentUsed = contextWindow > 0 ? Math.min(100, (totalTokens / contextWindow) * 100) : 0;
  const remainingTokens = Math.max(0, contextWindow - totalTokens);

  const reserveTokens = DEFAULT_RESERVE_TOKENS;
  const compactionThresholdTokens = Math.max(0, contextWindow - reserveTokens);
  const tokensUntilCompaction = Math.max(0, compactionThresholdTokens - totalTokens);
  const autoCompactBufferTokens = Math.min(
    reserveTokens,
    Math.max(0, contextWindow - totalTokens)
  );
  const freeTokens = Math.max(0, contextWindow - totalTokens - autoCompactBufferTokens);

  // 6. Compute percentages for items
  for (const item of allItems) {
    item.percentage = totalTokens > 0 ? (item.tokens / totalTokens) * 100 : 0;
  }

  // 7. Sort Top Consumers
  allItems.sort((a, b) => b.tokens - a.tokens);
  const topConsumers = allItems.slice(0, 5);

  // 8. Categories Breakdown
  const categories: CategoryBreakdown[] = [];

  if (toolTokens > 0 || toolCount > 0) {
    categories.push({
      category: "tool_result",
      label: "Tool Outputs",
      tokens: toolTokens,
      percentage: totalTokens > 0 ? (toolTokens / totalTokens) * 100 : 0,
      count: toolCount,
      toolCounts,
      toolTokens: toolTokensMap,
    });
  }

  if (assistantTokens > 0 || assistantCount > 0) {
    categories.push({
      category: "assistant",
      label: "Assistant Responses",
      tokens: assistantTokens,
      percentage: totalTokens > 0 ? (assistantTokens / totalTokens) * 100 : 0,
      count: assistantCount,
      subTokens: {
        thinkingTokens,
        textTokens,
        toolCallTokens,
      },
    });
  }

  if (systemTokens > 0) {
    categories.push({
      category: "system",
      label: "System Prompt",
      tokens: systemTokens,
      percentage: totalTokens > 0 ? (systemTokens / totalTokens) * 100 : 0,
      count: 1,
    });
  }

  if (userTokens > 0 || userCount > 0) {
    categories.push({
      category: "user",
      label: "User Messages",
      tokens: userTokens,
      percentage: totalTokens > 0 ? (userTokens / totalTokens) * 100 : 0,
      count: userCount,
    });
  }

  if (compactionSummaryTokens > 0) {
    categories.push({
      category: "compaction",
      label: "Compacted Summary",
      tokens: compactionSummaryTokens,
      percentage: totalTokens > 0 ? (compactionSummaryTokens / totalTokens) * 100 : 0,
      count: 1,
    });
  }

  // 9. Last Turn Metrics from the latest Assistant Message
  let lastTurn: LastTurnMetrics | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry.type === "message" && entry.message?.role === "assistant" && entry.message.usage) {
      const u = entry.message.usage;
      const promptTokens = u.input ?? 0;
      const cachedTokens = u.cacheRead ?? 0;
      const cacheWriteTokens = u.cacheWrite ?? 0;
      const outputTokens = u.output ?? 0;
      const totalPrompt = promptTokens + cachedTokens + cacheWriteTokens;
      const cacheHitRate = totalPrompt > 0 ? (cachedTokens / totalPrompt) * 100 : 0;

      lastTurn = {
        promptTokens,
        cachedTokens,
        cacheHitRate,
        cacheWriteTokens,
        outputTokens,
        totalTokens: u.totalTokens || (totalPrompt + outputTokens),
        stopReason: entry.message.stopReason,
        model: entry.message.responseModel || entry.message.model,
      };
      break;
    }
  }

  return {
    modelId,
    provider,
    contextWindow,
    totalTokens,
    percentUsed,
    remainingTokens,
    reserveTokens,
    compactionThresholdTokens,
    tokensUntilCompaction,
    freeTokens,
    autoCompactBufferTokens,
    categories,
    topConsumers,
    allConsumers: allItems,
    messageCount: projection.messages.length,
    lastTurn,
    compaction,
    analyzedAt: Date.now(),
  };
}
