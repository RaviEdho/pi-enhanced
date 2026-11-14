import { Agent } from "undici";

/** Own Discord's dispatcher instead of sharing the host SDK's mutable globals. */
export function createDiscordRestTransport() {
  // Discord.js uses the Undici 6 dispatcher API. Importing Pi's SDK loads Undici
  // 8, which replaces the legacy global dispatcher with a compatibility wrapper.
  // Multipart uploads through that wrapper can hang although JSON still works.
  // Keep this direct dependency on major 6 and pass the agent explicitly.
  const agent = new Agent();
  return {
    options: {
      agent,
      // An aborted POST may already have reached Discord. Do not automatically
      // replay it, or let retries outlast the image tool's IPC deadline.
      retries: 0,
    },
    close: () => agent.destroy(),
  };
}
