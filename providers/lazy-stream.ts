import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** Load inference-only code on the first request while retaining Pi's synchronous stream API. */
export function lazyStream(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
  load: () => Promise<() => AssistantMessageEventStream>,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  let finished = false;
  const fail = (error: unknown) => {
    if (finished) return;
    finished = true;
    const reason = options?.signal?.aborted ? "aborted" : "error";
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: reason, timestamp: Date.now(),
      errorMessage: reason === "aborted" ? "Request cancelled by caller" : String(error),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: "error", reason, error: message });
    stream.end();
  };
  const onAbort = () => fail(new Error("Request cancelled by caller"));
  options?.signal?.addEventListener("abort", onAbort, { once: true });
  void (async () => {
    try {
      options?.signal?.throwIfAborted();
      const start = await load();
      options?.signal?.throwIfAborted();
      // After loading, let the provider own cancellation so its partial content
      // and usage survive an abort instead of replacing them with an empty error.
      options?.signal?.removeEventListener("abort", onAbort);
      for await (const event of start()) {
        if (finished) break;
        stream.push(event);
        if (event.type === "done" || event.type === "error") finished = true;
      }
      if (!finished) fail(new Error("Provider stream ended without a terminal event"));
      stream.end();
    } catch (error) {
      fail(error);
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  })();
  return stream;
}
