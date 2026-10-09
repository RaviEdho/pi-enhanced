import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createMultiGrepToolDefinition,
} from "../scout/tools.js";
import {
  createWebFetchToolDefinition,
  createWebSearchToolDefinition,
} from "../web/tools.js";
import type { SubagentProgress, SubagentResult, SubagentRunOptions, SubagentTokenUsage } from "./types.js";

const DEFAULT_SUBAGENT_SYSTEM_PROMPT = `You are a focused, autonomous subagent running in an isolated execution sandbox.
Your role is to accomplish the delegated task directly, thoroughly, and concisely.
Work independently, inspect what you need, make necessary edits if tasked, and provide a clear, synthesized final response.
Use dedicated search tools ('find', 'grep', 'multi_grep') and web tools ('web_search', 'web_fetch') whenever appropriate instead of running verbose shell commands.
Keep your final output informative but concise so it integrates cleanly back into the parent conversation.`;

const READONLY_ADDENDUM = `\n\nREAD-ONLY MODE: You are operating in read-only mode. Workspace editing tools ('edit', 'write') are disabled. Do not attempt to modify, create, or delete workspace files or execute mutating shell commands. Focus purely on inspection, search, analysis, and synthesis.`;

const ALL_SUBAGENT_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "find",
  "grep",
  "multi_grep",
  "web_search",
  "web_fetch",
];

const DEFAULT_MAX_TURNS = 25;
const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

/**
 * Executes a task in an isolated in-process subagent session.
 * Inherits the parent agent's model and thinking level.
 */
export async function runSubagent(options: SubagentRunOptions): Promise<SubagentResult> {
  const startTime = Date.now();
  const cwd = options.cwd;
  const agentDir = getAgentDir();

  const isReadOnly = Boolean(options.readOnly);
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Determine allowed tool names
  const baseToolNames = isReadOnly
    ? ALL_SUBAGENT_TOOL_NAMES.filter((t) => t !== "edit" && t !== "write")
    : [...ALL_SUBAGENT_TOOL_NAMES];

  let selectedTools: string[];
  if (options.tools && options.tools.length > 0) {
    selectedTools = options.tools
      .map((t) => t.trim())
      .filter((t) => Boolean(t) && t !== "subagent" && (!isReadOnly || (t !== "edit" && t !== "write")));
    if (selectedTools.length === 0) {
      selectedTools = baseToolNames;
    }
  } else {
    selectedTools = baseToolNames;
  }

  // Provide enhanced custom tool definitions to the isolated session
  const customTools = [
    createFindToolDefinition("find"),
    createGrepToolDefinition("grep"),
    createMultiGrepToolDefinition("multi_grep"),
    createWebSearchToolDefinition(),
    createWebFetchToolDefinition(),
  ];

  const basePrompt = options.systemPrompt || DEFAULT_SUBAGENT_SYSTEM_PROMPT;
  const systemPrompt = isReadOnly ? `${basePrompt}${READONLY_ADDENDUM}` : basePrompt;

  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    systemPrompt,
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
    customTools,
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

  const internalAbortController = new AbortController();
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  if (timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      internalAbortController.abort(new Error(`Subagent execution timed out after ${timeoutMs / 1000}s.`));
    }, timeoutMs);
    timeoutTimer.unref?.();
  }

  const onExternalAbort = () => {
    internalAbortController.abort(new Error("Subagent execution was aborted by caller."));
  };

  if (options.signal) {
    if (options.signal.aborted) {
      internalAbortController.abort(new Error("Subagent execution was aborted before starting."));
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "turn_start") {
      turns++;
      if (maxTurns > 0 && turns > maxTurns) {
        internalAbortController.abort(
          new Error(`Subagent reached maximum turn limit (${maxTurns} turns).`)
        );
      }
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
    if (internalAbortController.signal.aborted) {
      reject(internalAbortController.signal.reason || new Error("Subagent execution was aborted."));
    } else {
      internalAbortController.signal.addEventListener(
        "abort",
        () => reject(internalAbortController.signal.reason || new Error("Subagent execution was aborted.")),
        { once: true }
      );
    }
  });

  let executionError: Error | undefined;

  try {
    await Promise.race([session.prompt(options.task), abortPromise]);

    // Inspect assistant messages for errors that Pi does not throw as JS exceptions
    const assistantMessages = session.messages.filter((m) => m.role === "assistant");
    const lastAssistant = assistantMessages[assistantMessages.length - 1];

    if (lastAssistant && lastAssistant.stopReason === "error") {
      const errDetail = lastAssistant.errorMessage || "Unknown provider error";
      throw new Error(`Subagent model returned an error: ${errDetail}`);
    }

    if (lastAssistant && lastAssistant.stopReason === "aborted" && internalAbortController.signal.aborted) {
      throw (internalAbortController.signal.reason || new Error("Subagent execution was aborted."));
    }

    let output = session.getLastAssistantText();
    if (!output || !output.trim()) {
      // Fallback: collect any text content generated across earlier turns if final turn was blank
      const collected = assistantMessages
        .flatMap((m) => m.content)
        .filter((c): c is { type: "text"; text: string } => c.type === "text" && Boolean(c.text.trim()))
        .map((c) => c.text.trim())
        .join("\n\n");
      output = collected || "(Subagent completed without generating a response)";
    }

    const durationMs = Date.now() - startTime;

    return {
      output,
      turns,
      usage,
      durationMs,
      model: `${options.model.provider}/${options.model.id}`,
      thinkingLevel: options.thinkingLevel,
    };
  } catch (err: any) {
    executionError = err instanceof Error ? err : new Error(String(err));
    throw executionError;
  } finally {
    unsubscribe();
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (options.signal) {
      options.signal.removeEventListener("abort", onExternalAbort);
    }

    if (internalAbortController.signal.aborted || executionError) {
      try {
        await session.abort();
      } catch {
        // ignore
      }
    }
    try {
      session.dispose();
    } catch {
      // ignore
    }
  }
}
