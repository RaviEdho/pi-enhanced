import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AccountStore } from "./store.js";
import type { AccountCredential } from "./types.js";

const PROVIDER_NAMES: Record<string, string> = {
  "google-antigravity": "Google Antigravity",
  hyper: "Charm Hyper",
  "openai-codex": "OpenAI Codex",
  openai: "OpenAI",
};

/**
 * Installs a lightweight hook on Pi's ModelRuntime.logout to intercept provider logouts
 * when multiple accounts are configured for that provider.
 */
export function installLogoutHook(ctx: ExtensionContext): void {
  const modelRegistry = ctx.modelRegistry as unknown as { runtime?: any };
  const runtime = modelRegistry?.runtime;
  if (!runtime || typeof runtime.logout !== "function" || runtime.logout._isMultiAccountHooked) {
    return;
  }

  const originalLogout = runtime.logout.bind(runtime);

  const hookedLogout = async (providerId: string, options: any = {}) => {
    // In non-TUI modes or if UI is unavailable, fall back to native logout
    if (!ctx.hasUI || ctx.mode !== "tui") {
      return originalLogout(providerId, options);
    }

    const store = AccountStore.getInstance();
    store.reloadIfModified(true);

    const accounts = store.list(providerId);

    // If 1 or 0 accounts configured, native Pi flow handles it completely
    if (accounts.length <= 1) {
      if (accounts.length === 1) {
        store.remove(accounts[0].id);
      }
      return originalLogout(providerId, options);
    }

    // Multiple accounts exist: show native-style account selector
    const activeAccount = store.getActive(providerId);
    const providerName = PROVIDER_NAMES[providerId] || providerId;

    const optionsList: string[] = [];
    const accountMap = new Map<string, AccountCredential>();

    for (const acc of accounts) {
      const isActive = activeAccount?.id === acc.id;
      const identity = acc.email || acc.orgName || acc.id;
      const label = `${identity}${isActive ? " (active)" : ""}`;
      optionsList.push(label);
      accountMap.set(label, acc);
    }

    const allOptionLabel = `All accounts (${accounts.length})`;
    optionsList.push(allOptionLabel);

    const selected = await ctx.ui.select(
      `Select ${providerName} account to logout:`,
      optionsList
    );

    // If user cancelled with Esc:
    if (!selected) {
      throw new Error("Logout cancelled.");
    }

    // If "All accounts (N)" was selected:
    if (selected === allOptionLabel) {
      store.removeAllForProvider(providerId);
      const res = await originalLogout(providerId, options);
      ctx.ui.notify(`Logged out of all ${providerName} accounts.`, "info");
      return res;
    }

    // If a specific account was selected:
    const chosenAccount = accountMap.get(selected);
    if (!chosenAccount) {
      throw new Error("Logout cancelled.");
    }

    store.remove(chosenAccount.id);
    const newActive = store.getActive(providerId);
    const chosenIdentity = chosenAccount.email || chosenAccount.orgName || chosenAccount.id;

    if (newActive) {
      const newActiveIdentity = newActive.email || newActive.orgName || newActive.id;
      ctx.ui.notify(
        `Logged out ${chosenIdentity}. Active account is now ${newActiveIdentity}.`,
        "info"
      );
      // Refresh runtime model catalog/auth state for this provider
      try {
        await runtime.refresh?.({ providers: [providerId] });
      } catch {
        // Ignore refresh errors
      }
    } else {
      ctx.ui.notify(`Logged out ${chosenIdentity}.`, "info");
      return originalLogout(providerId, options);
    }
  };

  hookedLogout._isMultiAccountHooked = true;
  runtime.logout = hookedLogout;
}
