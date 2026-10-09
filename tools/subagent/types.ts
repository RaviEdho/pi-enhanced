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
}

export interface SubagentRunOptions {
  task: string;
  description?: string;
  tools?: string[];
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
