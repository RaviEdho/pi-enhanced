export interface CommitProposal {
  type: string;
  scope?: string;
  subject: string;
  body?: string;
}

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStagedOverview {
  stagedFiles: string[];
  statSummary: string;
}

export interface CommitActionEntry {
  type: "status" | "overview" | "diff" | "proposal" | "tool" | "info";
  description: string;
  timestamp: number;
}

export interface CommitUsageCost {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number; // in USD
  turns: number;
  durationMs: number;
  modelId: string;
  provider: string;
  isSubscription?: boolean;
}

export interface CommitConfirmationResult {
  action: "commit" | "edit" | "cancel";
  message?: string;
}
