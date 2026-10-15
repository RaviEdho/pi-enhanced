import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { EnhancedSettingsComponent } from "./component.js";
import { formatEnhancedSettings, formatSettingValue } from "./format.js";
import { EnhancedSettingsStore } from "./store.js";
import {
  SETTING_DEFINITIONS,
  type EnhancedSettingKey,
} from "./types.js";

/**
 * Handles the /settings-enhanced command.
 */
export async function handleSettingsEnhancedCommand(
  args: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  const store = EnhancedSettingsStore.getInstance();
  const trimmed = args.trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const action = parts[0]?.toLowerCase();

  // Subcommand: reset
  if (action === "reset") {
    store.reset();
    if (ctx.hasUI) {
      ctx.ui.notify("Enhanced settings reset to default values", "info");
    } else {
      console.log("Enhanced settings reset to default values.");
    }
    return;
  }

  // Subcommand: list
  if (action === "list") {
    const output = formatEnhancedSettings(store.getAll(), store.getFilePath());
    if (ctx.hasUI) {
      ctx.ui.notify(output, "info");
    } else {
      console.log(output);
    }
    return;
  }

  // Subcommand: get <key>
  if (action === "get") {
    const key = parts[1] as EnhancedSettingKey;
    if (!key || !(key in SETTING_DEFINITIONS)) {
      const validKeys = Object.keys(SETTING_DEFINITIONS).join(", ");
      const msg = `Unknown setting key. Available keys:\n${validKeys}`;
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "error");
      } else {
        console.error(msg);
      }
      return;
    }

    const val = store.get(key);
    const formatted = `${key} = ${formatSettingValue(key, val)}`;
    if (ctx.hasUI) {
      ctx.ui.notify(formatted, "info");
    } else {
      console.log(formatted);
    }
    return;
  }

  // Subcommand: set <key> <value>
  if (action === "set") {
    const key = parts[1] as EnhancedSettingKey;
    const rawVal = parts[2]?.toLowerCase();

    if (!key || !(key in SETTING_DEFINITIONS)) {
      const validKeys = Object.keys(SETTING_DEFINITIONS).join(", ");
      const msg = `Unknown setting key. Available keys:\n${validKeys}`;
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "error");
      } else {
        console.error(msg);
      }
      return;
    }

    const def = SETTING_DEFINITIONS[key];
    if (typeof def.defaultValue === "boolean") {
      if (rawVal === "true" || rawVal === "enabled" || rawVal === "1" || rawVal === "on") {
        store.set(key, true as any);
      } else if (rawVal === "false" || rawVal === "disabled" || rawVal === "0" || rawVal === "off") {
        store.set(key, false as any);
      } else {
        const msg = `Invalid value for ${key}. Expected 'enabled' or 'disabled'.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
        return;
      }
    } else if (def.options.includes(rawVal)) {
      store.set(key, rawVal as any);
    } else {
      const msg = `Invalid value for ${key}. Allowed: ${def.options.join(", ")}`;
      if (ctx.hasUI) ctx.ui.notify(msg, "error");
      else console.error(msg);
      return;
    }

    const updated = store.get(key);
    const msg = `Set ${key} = ${formatSettingValue(key, updated)}`;
    if (ctx.hasUI) {
      ctx.ui.notify(msg, "info");
    } else {
      console.log(msg);
    }
    return;
  }

  // Default interactive / TUI mode
  if (ctx.hasUI && ctx.mode === "tui") {
    await ctx.ui.custom<void>((tui, theme, _kb, done) => {
      return new EnhancedSettingsComponent(tui, theme, () => done(undefined));
    });
    return;
  }

  // Non-TUI mode fallback: print settings overview
  const output = formatEnhancedSettings(store.getAll(), store.getFilePath());
  console.log(output);
}
