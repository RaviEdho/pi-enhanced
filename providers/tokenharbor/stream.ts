import {
  createAssistantMessageEventStream,
  type Api, type AssistantMessage, type AssistantMessageEventStream, type Model,
  type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { OpenAICompletionsOptions } from "@earendil-works/pi-ai/api/openai-completions";
import type { ResolvedAccountAuth } from "../../accounts/types.js";
import type { TokenHarborModel } from "./models.js";
import { isTokenHarborModelAllowed, verifyTokenHarborRequest } from "./access.js";
import { isTokenHarborEffortSupported, withTokenHarborReasoning } from "./reasoning.js";

/** Never rotate credentials to bypass an intentional spending, access, or account-quota boundary. */
export function canFailoverTokenHarbor(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too.?many.?requests/i.test(text) &&
    !/spend|budget|hard.?cap|quota|allowance|balance|billing|payment|credit|vendor_not_allowed|per.?ip|ip.address|network|global|shared|403|402/i.test(text);
}

export function streamTokenHarbor(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | OpenAICompletionsOptions | undefined,
  auth: ResolvedAccountAuth,
  simple = true,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const redact = (text: string) => text.replaceAll(auth.token, "[redacted]")
    .replace(/thk_live_[A-Za-z0-9_-]+/g, "[redacted]");
  const finalize = (message: AssistantMessage) => {
    if (message.errorMessage) message.errorMessage = redact(message.errorMessage);
  };
  void (async () => {
    try {
      const reasoning = await verifyTokenHarborRequest(auth.token, model.id, options?.signal);
      const typedModel = withTokenHarborReasoning(model as TokenHarborModel, reasoning ?? (model as TokenHarborModel).tokenHarborReasoning);
      // Omission means the gateway's default, not an invented default or "none".
      const requested = simple ? (options as SimpleStreamOptions | undefined)?.reasoning
        : (options as OpenAICompletionsOptions | undefined)?.reasoningEffort;
      if (requested === undefined) typedModel.thinkingLevelMap = { ...typedModel.thinkingLevelMap, off: null };
      const requestOptions: OpenAICompletionsOptions | SimpleStreamOptions = {
        ...options, apiKey: auth.token,
        onPayload: async (payload, requestModel) => {
          const replacement = await options?.onPayload?.(payload, requestModel);
          const actual = replacement === undefined ? payload : replacement;
          if (!actual || typeof actual !== "object" || Array.isArray(actual)
            || (actual as Record<string, unknown>).model !== model.id) {
            throw new Error("Token Harbor model substitution is blocked by the Pass coverage policy.");
          }
          if (!model.id.endsWith(":free") && !isTokenHarborModelAllowed(auth.token, model.id, true)) {
            throw new Error("Token Harbor Pass coverage or allowance changed or expired while preparing the request; refresh models.");
          }
          const effort = (actual as Record<string, unknown>).reasoning_effort;
          if (effort !== undefined && !isTokenHarborEffortSupported(typedModel.tokenHarborReasoning, effort)) {
            throw new Error("Token Harbor reasoning effort is not verified for this model; refresh models or omit the control.");
          }
          return actual;
        },
      };
      options?.signal?.throwIfAborted();
      const implementation = openAICompletionsApi();
      const inner = simple ? implementation.streamSimple(typedModel, context, requestOptions as SimpleStreamOptions)
        : implementation.stream(typedModel, context, requestOptions as OpenAICompletionsOptions);
      for await (const event of inner) {
        if (event.type === "done") finalize(event.message);
        if (event.type === "error") finalize(event.error);
        output.push(event);
      }
    } catch (error) {
      const aborted = options?.signal?.aborted;
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [], timestamp: Date.now(), stopReason: aborted ? "aborted" : "error",
        errorMessage: aborted ? "Request cancelled by caller" : error instanceof Error ? redact(error.message) : "Token Harbor stream failed.",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      output.push({ type: "error", reason: message.stopReason as "aborted" | "error", error: message });
    } finally { output.end(); }
  })();
  return output;
}
