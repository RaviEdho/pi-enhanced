import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installLogoutHook } from "./accounts/index.js";
import { registerProviders } from "./providers/index.js";
import { registerTools } from "./tools/index.js";
import { registerUX } from "./ux/index.js";

export default async function (pi: ExtensionAPI) {
  // Register custom inference providers & dynamic model catalogs (Antigravity, Hyper, Codex)
  await registerProviders(pi);

  // Register workflow & UX enhancements (working timer, continue shortcut, quota monitor & footer)
  registerUX(pi);

  // Register agent capabilities & tools (scout search, web search/fetch, commit sub-agent, output compressor)
  registerTools(pi);

  // Hook into Pi's ModelRuntime.logout to present native account selector on multi-account logout
  pi.on("session_start", async (_event, ctx) => {
    installLogoutHook(ctx);
  });
}
