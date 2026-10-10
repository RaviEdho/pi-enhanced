import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

export interface SubagentTokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
}

export interface SubagentProgress {
  status: string;
  turns: number;
  tokens: number;
  currentTool?: string;
  recentSteps?: string[];
}

export interface SubagentRunOptions {
  task: string;
  description?: string;
  tools?: string[];
  readOnly?: boolean;
  maxTurns?: number;
  timeoutMs?: number;
  systemPrompt?: string;
  cwd: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  modelRuntime?: any;
  signal?: AbortSignal;
  onUpdate?: (progress: SubagentProgress) => void;
}

export interface SubagentResult {
  output: string;
  turns: number;
  usage: SubagentTokenUsage;
  durationMs: number;
  model: string;
  thinkingLevel: ThinkingLevel;
}

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJob {
  id: string;
  task: string;
  description: string;
  status: JobStatus;
  turns: number;
  lastStatus: string;
  currentTool?: string;
  recentSteps: string[];
  tokens: number;
  result?: SubagentResult;
  error?: string;
  abortController: AbortController;
  startTime: number;
  endTime?: number;
  deliverAsFollowUp: boolean;
  modelName: string;
  thinkingLevel: ThinkingLevel;
  polledByAgent: boolean;
  followUpDelivered: boolean;
  pendingFollowUp: boolean;
}

export interface SubagentReportDetails {
  jobId: string;
  description: string;
  status: JobStatus;
  durationMs: number;
  turns: number;
  tokens: number;
  output?: string;
  error?: string;
  modelName: string;
}
