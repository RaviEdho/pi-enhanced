import type { CommitProposal, CommitUsageCost } from "./types.js";

/**
 * Format token counts compactly (e.g. 850, 1.2k, 25k, 1.5M).
 */
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/**
 * Format cost in USD with high precision for micro-transactions.
 */
export function formatCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.0001) return "<$0.0001";
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

/**
 * Format duration in human-readable units (e.g. 450ms, 2.3s, 1m12s, 1h5m3s).
 */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.max(1, Math.round(durationMs))}ms`;
  const seconds = durationMs / 1000;
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainingSec = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m${remainingSec}s`;
  }
  return `${minutes}m${remainingSec}s`;
}

/**
 * Generates a concise single-line cost and token summary badge.
 */
export function formatCostBadge(usage: CommitUsageCost): string {
  const costPart = usage.totalCost > 0
    ? formatCost(usage.totalCost)
    : (usage.isSubscription ? "subscription" : "$0.00");
  return `${costPart} (${formatTokens(usage.totalTokens)} tok)`;
}

/**
 * Formats a multi-stage or single-stage commit plan for the interactive text editor.
 */
export function formatPlanForEditor(stages: CommitProposal[]): string {
  const parts: string[] = [];
  parts.push("# Edit your commit stages below.");
  parts.push("# Each commit begins with '=== COMMIT: <type>(<scope>): <subject> ==='");
  parts.push("# Followed optionally by 'Files: path1, path2' and markdown bullet points.");
  parts.push("# To merge into a single commit, remove extra '=== COMMIT' blocks.");
  parts.push("# Lines starting with '#' are ignored.");
  parts.push("");

  for (const stage of stages) {
    const type = stage.type.trim().toLowerCase();
    const scope = stage.scope?.trim().toLowerCase();
    const subject = stage.subject.trim().replace(/\.$/, "");
    const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
    parts.push(`=== COMMIT: ${header} ===`);
    if (stage.files && stage.files.length > 0) {
      parts.push(`Files: ${stage.files.join(", ")}`);
    }
    if (stage.body?.trim()) {
      parts.push(stage.body.trim());
    }
    parts.push("");
  }
  return parts.join("\n");
}

/**
 * Parses an edited text buffer back into structured CommitProposal stages.
 */
export function parsePlanFromEditor(text: string): CommitProposal[] {
  const lines = text.split("\n");
  const stages: CommitProposal[] = [];
  let currentHeader = "";
  let currentFiles: string[] = [];
  let currentBodyLines: string[] = [];

  const flush = () => {
    if (!currentHeader.trim()) return;
    const headerMatch = currentHeader.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
    const type = headerMatch ? headerMatch[1].trim() : "chore";
    const scope = headerMatch && headerMatch[2] ? headerMatch[2].trim() : undefined;
    const subject = headerMatch ? headerMatch[3].trim() : currentHeader.trim();
    const body = currentBodyLines.join("\n").trim() || undefined;
    stages.push({
      type,
      scope,
      subject,
      body,
      files: currentFiles.length > 0 ? currentFiles : undefined,
    });
    currentHeader = "";
    currentFiles = [];
    currentBodyLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;

    const commitMarker = line.match(/^===\s*COMMIT:\s*(.*?)\s*===$/i);
    if (commitMarker) {
      flush();
      currentHeader = commitMarker[1].trim();
      continue;
    }

    if (line.toLowerCase().startsWith("files:")) {
      const filesStr = line.slice(6).trim();
      currentFiles = filesStr.split(",").map((f) => f.trim()).filter(Boolean);
      continue;
    }

    if (currentHeader) {
      currentBodyLines.push(rawLine);
    }
  }

  flush();

  // If no "=== COMMIT" markers were used (user edited into a standard single commit message), parse as 1 commit:
  if (stages.length === 0 && text.trim()) {
    const cleanLines = text.split("\n").filter((l) => !l.trim().startsWith("#"));
    const firstLine = cleanLines.find((l) => l.trim().length > 0)?.trim() || "";
    if (firstLine) {
      const headerMatch = firstLine.match(/^(\w+)(?:\(([^)]+)\))?:\s*(.+)$/);
      const type = headerMatch ? headerMatch[1].trim() : "chore";
      const scope = headerMatch && headerMatch[2] ? headerMatch[2].trim() : undefined;
      const subject = headerMatch ? headerMatch[3].trim() : firstLine;
      const rest = cleanLines.slice(cleanLines.indexOf(firstLine) + 1).join("\n").trim();
      stages.push({
        type,
        scope,
        subject,
        body: rest || undefined,
      });
    }
  }

  return stages;
}
