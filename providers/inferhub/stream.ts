import {
  createAssistantMessageEventStream,
  type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/api/openai-completions";
import { record } from "./http.js";
import type { InferHubModel } from "./models.js";

/** Delegate message/tool/SSE conversion to Pi; only adapt routing and settled cost. */
export function streamInferHub(
  model: Model<"openai-completions">,
  transcript: TranscriptContext,
  options: SimpleStreamOptions | OpenAICompletionsOptions | undefined,
  simple = true,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const key = options?.apiKey?.trim();
  const redact = (text: string) => (key ? text.replaceAll(key, "[redacted]") : text)
    .replace(/sk-airo-[A-Za-z0-9_-]+/g, "[redacted]");
  let actualCost: number | undefined;
  const finalize = (message: AssistantMessage) => {
    // The provider supplies a total only. Do not fabricate input/cache cost splits.
    message.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: actualCost ?? 0 };
    if (message.errorMessage) message.errorMessage = redact(message.errorMessage);
  };
  void (async () => {
    try {
      options?.signal?.throwIfAborted();
      if (!key) throw new Error("No InferHub API key; run /login inferhub or set INFERHUB_API_KEY.");
      const efforts = (model as InferHubModel).inferHubReasoningLevels ?? [];
      const requested = simple ? (options as SimpleStreamOptions | undefined)?.reasoning ?? "off"
        : (options as OpenAICompletionsOptions | undefined)?.reasoningEffort;
      // Native Pi represents 'off' by omitting SimpleStreamOptions.reasoning.
      // Raw API calls with no effort leave the upstream default unchanged.
      const requestModel = requested === undefined
        ? { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, off: null } } : model;
      const headers = { ...options?.headers };
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "x-inferhub-reasoning-mode"
          || (options?.sessionId && name.toLowerCase() === "x-session-id")) delete headers[name];
      }
      headers["X-InferHub-Reasoning-Mode"] = "strict";
      if (options?.sessionId) headers["X-Session-Id"] = options.sessionId;
      const requestOptions = {
        ...options, apiKey: key, headers,
        onPayload: async (payload: unknown, requestModel: Model<"openai-completions">) => {
          const replacement = await options?.onPayload?.(payload, requestModel);
          const actual = replacement === undefined ? payload : replacement;
          const body = record(actual);
          if (!body || body.model !== model.id) throw new Error("InferHub model substitution requires selecting that model first.");
          if (requested === "off" && efforts.includes("none") && body.reasoning_effort === undefined) body.reasoning_effort = "none";
          if (body.reasoning_effort !== undefined && !efforts.includes(body.reasoning_effort as string)) {
            throw new Error("InferHub reasoning effort is not supported by this route; refresh models or omit the effort.");
          }
          return actual;
        },
        onProviderStreamEvent: async (data: unknown, requestModel: Model<"openai-completions">) => {
          const cost = record(record(data)?.usage)?.cost;
          if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) actualCost = cost;
          await options?.onProviderStreamEvent?.(data, requestModel);
        },
      };
      const implementation = openAICompletionsApi();
      const inner = simple ? implementation.streamSimple(requestModel, transcript, requestOptions as SimpleStreamOptions)
        : implementation.stream(requestModel, transcript, requestOptions as OpenAICompletionsOptions);
      for await (const event of inner) {
        if (event.type === "done") finalize(event.message);
        if (event.type === "error") finalize(event.error);
        output.push(event);
      }
    } catch (error) {
      const reason = options?.signal?.aborted ? "aborted" : "error";
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(),
        stopReason: reason,
        errorMessage: reason === "aborted" ? "Request cancelled by caller"
          : error instanceof Error ? redact(error.message) : "InferHub stream failed.",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: actualCost ?? 0 } },
      };
      output.push({ type: "error", reason, error: message });
    } finally { output.end(); }
  })();
  return output;
}
