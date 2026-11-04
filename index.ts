import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installLogoutHook } from "./accounts/logout.js";
import { removeRetiredHyperData } from "./accounts/retired.js";
import { registerProviders } from "./providers/index.js";
import { registerTools } from "./tools/register.js";
import { registerUX } from "./ux/register.js";
import { registerDiscordGateway } from "./gateway/register.js";

export default async function (pi: ExtensionAPI) {
  // Purge retired provider credentials before any account store is initialized.
  await removeRetiredHyperData();

  // Register custom inference providers & dynamic model catalogs.
  await registerProviders(pi);

  // Register workflow & UX enhancements (working timer, continue shortcut, quota monitor & footer)
  registerUX(pi);

  // Register agent capabilities & tools (scout search, web search/fetch, commit sub-agent, output compressor)
  registerTools(pi);
  await registerDiscordGateway(pi);

  // Hook into Pi's ModelRuntime.logout to present native account selector on multi-account logout
  pi.on("session_start", async (_event, ctx) => {
    installLogoutHook(ctx);
  });
}
