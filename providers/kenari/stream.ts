import type {
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ResolvedAccountAuth } from "../../accounts/types.js";
import { KENARI_USER_AGENT } from "./constants.js";

/**
 * Streams completion requests to Kenari via OpenAI Completions compatibility.
 */
export function streamKenari(
  model: Model<Api>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  auth: ResolvedAccountAuth
): AssistantMessageEventStream {
  const customHeaders: Record<string, string> = {
    ...options?.headers,
    "User-Agent": KENARI_USER_AGENT,
  };

  const streamOptions: SimpleStreamOptions = {
    ...options,
    apiKey: auth.token,
    headers: customHeaders,
  };

  return openAICompletionsApi().streamSimple(
    model as Model<"openai-completions">,
    context,
    streamOptions
  );
}
