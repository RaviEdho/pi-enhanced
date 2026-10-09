import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { SubagentProgress, SubagentResult, SubagentRunOptions, SubagentTokenUsage } from "./types.js";

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = `You are a focused, autonomous subagent running in an isolated execution sandbox.
Your role is to accomplish the delegated task directly, thoroughly, and concisely.
Work independently, inspect what you need, make necessary edits if tasked, and provide a clear, synthesized final response.
Keep your final output informative but concise so it integrates cleanly back into the parent conversation.`;

const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];

/**
 * Executes a task in an isolated in-process subagent session.
 * Inherits the parent agent's model and thinking level.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const startTime = Date.now();
  const cwd = options.cwd;
  const agentDir = getAgentDir();

  // Filter tools to avoid recursive self-invocation
  let selectedTools: string[];
  if (options.tools && options.tools.length > 0) {
    selectedTools = options.tools
      .map((t) => t.trim())
      .filter((t) => Boolean(t) && t !== "subagent");
    if (selectedTools.length === 0) {
      selectedTools = [...DEFAULT_TOOLS];
    }
  } else {
    selectedTools = [...DEFAULT_TOOLS];
  }

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPrompt: options.systemPrompt || DEFAULT_SUBAGENT_SYSTEM_PROMPT,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  if (options.signal?.aborted) {
    throw new Error("Subagent execution was aborted before starting.");
  }

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime: options.modelRuntime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader,
    tools: selectedTools,
  });

  let turns = 0;
  const usage: SubagentTokenUsage = {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };

  let currentStatus = "Subagent started...";

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      turns++;
      currentStatus = `Turn ${turns}...`;
      options.onUpdate?.({ status: currentStatus, turns, tokens: usage.totalTokens });
    } else if (event.type === "tool_execution_start") {
      currentStatus = `Executing ${event.toolName}…`;
      options.onUpdate?.({ status: currentStatus, turns, tokens: usage.totalTokens });
    } else if (event.type === "message_end") {
      if (event.message.role === "assistant" && event.message.usage) {
        const u = event.message.usage;
        usage.input += u.input || 0;
        usage.output += u.output || 0;
        usage.reasoning += u.reasoning || 0;
        usage.cacheRead += u.cacheRead || 0;
        usage.cacheWrite += u.cacheWrite || 0;
        usage.totalTokens += u.totalTokens || ((u.input || 0) + (u.output || 0));
        options.onUpdate?.({ status: currentStatus, turns, tokens: usage.totalTokens });
      }
    }
  });

  const abortPromise = new Promise<never>((_, reject) => {
    if (options.signal) {
      if (options.signal.aborted) {
        reject(new Error("Subagent execution was aborted."));
      } else {
        options.signal.addEventListener(
          "abort",
          () => reject(new Error("Subagent execution was aborted.")),
          { once: true }
        );
      }
    }
  });

  try {
    await Promise.race([session.prompt(options.task), abortPromise]);
    const output = session.getLastAssistantText() || "(Subagent completed without generating a response)";
    const durationMs = Date.now() - startTime;

    return {
      output,
      turns,
      usage,
      durationMs,
      model: `${options.model.provider}/${options.model.id}`,
      thinkingLevel: options.thinkingLevel,
    };
  } finally {
    unsubscribe();
    if (options.signal?.aborted) {
      void session.abort().catch(() => {}).finally(() => {
        try {
          session.dispose();
        } catch {
          // ignore
        }
      });
    } else {
      try {
        session.dispose();
      } catch {
        // ignore
      }
    }
  }
}
