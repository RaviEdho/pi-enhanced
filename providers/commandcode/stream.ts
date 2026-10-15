import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  anthropicMessagesApi,
  openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import {
  calculateCost,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
} from "@earendil-works/pi-ai";
import type { ResolvedAccountAuth } from "../../accounts/types.js";
import {
  COMMANDCODE_API_BASE_URL,
  COMMANDCODE_USER_AGENT,
} from "./constants.js";
import { resolveModelCost } from "./models.js";

function toWireMessages(messages: TranscriptContext["messages"]): any[] {
  const wire: any[] = [];
  const toolNameMap = new Map<string, string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content: any[] = [];
      for (const part of msg.content) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "thinking") {
          content.push({ type: "reasoning", text: part.thinking });
        } else if (part.type === "toolCall") {
          toolNameMap.set(part.id, part.name);
          content.push({
            type: "tool-call",
            toolCallId: part.id,
            toolName: part.name,
            input: part.arguments ?? {},
          });
        }
      }
      wire.push({ role: "assistant", content });
    } else if (msg.role === "user") {
      const userContent: any[] = [];
      if (typeof msg.content === "string") {
        userContent.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (typeof part === "string") {
            userContent.push({ type: "text", text: part });
          } else if (part.type === "text") {
            userContent.push({ type: "text", text: part.text });
          } else if (part.type === "image") {
            userContent.push({
              type: "image",
              image: `data:${part.mimeType || "image/png"};base64,${part.data}`,
              mimeType: part.mimeType || "image/png",
            });
          }
        }
      }
      if (userContent.length > 0) {
        wire.push({ role: "user", content: userContent });
      }
    } else if (msg.role === "toolResult") {
      const textVal = Array.isArray(msg.content)
        ? msg.content.map((c: any) => (typeof c === "string" ? c : c.text || "")).join("\n")
        : typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content);

      wire.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: msg.toolCallId,
            toolName: toolNameMap.get(msg.toolCallId) ?? "unknown",
            output: { type: "text", value: textVal },
          },
        ],
      });
    }
  }

  return wire;
}

function toWireTools(tools: any[]): any[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema || t.parameters || { type: "object", properties: {} },
  }));
}

async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) yield trimmed;
      }
    }
    if (buffer.trim()) yield buffer.trim();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams completion requests directly through Command Code's internal CLI gateway
 * (https://api.commandcode.ai/alpha/generate).
 *
 * This allows accounts on the $1/month "Go" plan (which is blocked on the external
 * Provider API) to execute open models using their included CLI allocation.
 */
export function streamCommandCodeInternalGateway(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  auth: ResolvedAccountAuth
): AssistantMessageEventStream {
  const eventStream = createAssistantMessageEventStream();

  (async () => {
    try {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      const threadId = randomUUID();
      const sessionId = randomUUID();

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "cli",
        "x-command-code-version": "1.82.0",
        "x-cli-environment": "production",
        "x-cli-surface": "interactive",
        "x-session-id": sessionId,
        Authorization: `Bearer ${auth.token}`,
        ...options?.headers,
      };

      if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
        headers["x-cmd-zdr"] = "1";
      }

      const rawTools = getCurrentTools(context.messages);
      const rawSystem = getCurrentSystemPrompt(context.messages);

      const requestPayload = {
        config: {
          workingDir: process.cwd(),
          date: new Date().toISOString().split("T")[0],
          environment: process.platform,
          structure: [],
          isGitRepo: true,
          currentBranch: "main",
          mainBranch: "main",
          gitStatus: "",
          recentCommits: [],
        },
        memory: "",
        taste: null,
        skills: null,
        permissionMode: "default",
        threadId,
        mode: "agent",
        promptCache: "off",
        params: {
          model: model.id,
          messages: toWireMessages(context.messages),
          tools: toWireTools(rawTools),
          system: rawSystem || "You are a helpful coding assistant.",
          max_tokens: model.maxTokens || 16384,
          stream: true,
        },
      };

      const finalPayload = (await options?.onPayload?.(requestPayload, model)) ?? requestPayload;
      const requestUrl = `${COMMANDCODE_API_BASE_URL}/alpha/generate`;

      const response = await fetch(requestUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(finalPayload),
        signal: options?.signal,
      });

      if (options?.onResponse) {
        const headersRecord: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          headersRecord[key] = val;
        });
        await options.onResponse({ status: response.status, headers: headersRecord }, model);
      }

      if (!response.ok) {
        const errorText = await response.text();
        let parsedMessage = errorText;
        try {
          const parsed = JSON.parse(errorText);
          if (parsed?.error?.message) {
            parsedMessage = parsed.error.message;
          }
        } catch {
          // Ignore JSON parse error
        }
        throw new Error(`Command Code CLI Gateway error (${response.status}): ${parsedMessage}`);
      }

      if (!response.body) {
        throw new Error("No response body received from Command Code Gateway");
      }

      eventStream.push({ type: "start", partial: output });

      let currentBlock: TextContent | ThinkingContent | null = null;
      let toolCallCount = 0;

      const finishCurrentBlock = () => {
        if (!currentBlock) return;
        const blockIndex = output.content.length - 1;
        if (currentBlock.type === "text") {
          eventStream.push({
            type: "text_end",
            contentIndex: blockIndex,
            content: currentBlock.text,
            partial: output,
          });
        } else if (currentBlock.type === "thinking") {
          eventStream.push({
            type: "thinking_end",
            contentIndex: blockIndex,
            content: currentBlock.thinking,
            partial: output,
          });
        }
        currentBlock = null;
      };

      for await (const line of readLines(response.body)) {
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }

        if (event.type === "text-delta" && typeof event.text === "string") {
          if (currentBlock?.type !== "text") {
            finishCurrentBlock();
            const newBlock: TextContent = { type: "text", text: "" };
            output.content.push(newBlock);
            currentBlock = newBlock;
            eventStream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          currentBlock.text += event.text;
          eventStream.push({
            type: "text_delta",
            contentIndex: output.content.length - 1,
            delta: event.text,
            partial: output,
          });
        } else if (event.type === "reasoning-delta" && typeof event.text === "string") {
          if (currentBlock?.type !== "thinking") {
            finishCurrentBlock();
            const newBlock: ThinkingContent = { type: "thinking", thinking: "" };
            output.content.push(newBlock);
            currentBlock = newBlock;
            eventStream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
          currentBlock.thinking += event.text;
          eventStream.push({
            type: "thinking_delta",
            contentIndex: output.content.length - 1,
            delta: event.text,
            partial: output,
          });
        } else if (event.type === "reasoning-end") {
          if (currentBlock?.type === "thinking") {
            finishCurrentBlock();
          }
        } else if (event.type === "tool-call") {
          finishCurrentBlock();
          toolCallCount += 1;
          const callId = event.toolCallId || `call_${randomUUID().slice(0, 8)}_${toolCallCount}`;
          const toolCall: ToolCall = {
            type: "toolCall",
            id: callId,
            name: event.toolName || "",
            arguments: event.input || event.args || {},
          };

          output.content.push(toolCall);
          const toolIndex = output.content.length - 1;

          eventStream.push({
            type: "toolcall_start",
            contentIndex: toolIndex,
            partial: output,
          });
          eventStream.push({
            type: "toolcall_delta",
            contentIndex: toolIndex,
            delta: JSON.stringify(toolCall.arguments),
            partial: output,
          });
          eventStream.push({
            type: "toolcall_end",
            contentIndex: toolIndex,
            toolCall,
            partial: output,
          });
        } else if (event.type === "finish") {
          finishCurrentBlock();
          if (event.totalUsage) {
            output.usage.input = event.totalUsage.inputTokens || 0;
            output.usage.output = event.totalUsage.outputTokens || 0;
            output.usage.cacheRead = event.totalUsage.inputTokenDetails?.cacheReadTokens || 0;
            output.usage.cacheWrite = event.totalUsage.inputTokenDetails?.cacheWriteTokens || 0;
            output.usage.totalTokens = output.usage.input + output.usage.output;
            output.usage.cost = calculateCost(
              { ...model, cost: resolveModelCost(model.id) },
              output.usage
            );
          }
          output.stopReason =
            event.finishReason === "tool_calls" || event.finishReason === "tool-calls"
              ? "toolUse"
              : "stop";
        } else if (event.type === "error") {
          throw new Error(`Command Code stream error: ${event.message || JSON.stringify(event)}`);
        }
      }

      finishCurrentBlock();
      const doneReason = output.stopReason === "toolUse" ? "toolUse" : "stop";
      eventStream.push({ type: "done", reason: doneReason, message: output });
    } catch (err) {
      const finalError: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      eventStream.push({ type: "error", reason: "error", error: finalError });
    }
  })();

  return eventStream;
}

/**
 * Helper to identify whether an account plan represents an entry $1/mo "Go" subscription.
 */
export function isCommandCodeGoPlan(planType?: string): boolean {
  if (!planType) return false;
  const p = planType.toLowerCase();
  return p.includes("go") && !p.includes("goat");
}

/**
 * Streams completion requests to Command Code dynamically routing between:
 * 1. Internal CLI Gateway (/alpha/generate) for Go $1/mo subscriptions or when configured.
 * 2. Provider API (/provider/v1/messages) for Anthropic Claude models.
 * 3. Provider API (/provider/v1/chat/completions) for OpenAI and open-weight models.
 */
export function streamCommandCode(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  auth: ResolvedAccountAuth
): AssistantMessageEventStream {
  const isGoPlan = isCommandCodeGoPlan(auth.account.planType);
  const forceInternal =
    process.env.COMMANDCODE_USE_GATEWAY === "1" ||
    process.env.COMMANDCODE_INTERNAL === "1";

  // Use official CLI internal gateway for $1/mo Go accounts or explicit override
  if (isGoPlan || forceInternal) {
    return streamCommandCodeInternalGateway(model, context, options, auth);
  }

  const customHeaders: Record<string, string> = {
    ...options?.headers,
    "User-Agent": COMMANDCODE_USER_AGENT,
  };

  // Optional Zero Data Retention header
  if (process.env.CMD_ZDR === "1" || process.env.COMMANDCODE_ZDR === "1") {
    customHeaders["x-cmd-zdr"] = "1";
  }

  const streamOptions: SimpleStreamOptions = {
    ...options,
    apiKey: auth.token,
    headers: customHeaders,
  };

  if (model.api === "anthropic-messages") {
    return anthropicMessagesApi().streamSimple(
      model as Model<"anthropic-messages">,
      context,
      streamOptions
    );
  }

  return openAICompletionsApi().streamSimple(
    model as Model<"openai-completions">,
    context,
    streamOptions
  );
}
