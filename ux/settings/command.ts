import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { isFeedbackToolActive } from "../../tools/feedback/index.js";
import { isScoutActive } from "../../tools/scout/register.js";
import { isSubagentActive } from "../../tools/subagent/index.js";
import { isWebActive } from "../../tools/web/index.js";
import { refreshProviderCatalogs } from "../../providers/refresh.js";
import { findAvailablePickerModel, getAvailablePickerModels } from "../available-models.js";
import { EnhancedSettingsComponent } from "./component.js";
import { formatEnhancedSettings, formatSettingValue } from "./format.js";
import { EnhancedSettingsStore } from "./store.js";
import {
  TOOL_CACHE_SETTINGS,
  TOOL_CACHE_WARNING_TOKENS,
  describeToolCacheChange,
  isToolCacheSetting,
} from "./tool-cache.js";
import {
  MODEL_SETTING_SESSION_VALUE,
  SETTING_DEFINITIONS,
  isModelSetting,
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
  store.refresh();
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
    const activeSettings = store.getAll();
    activeSettings["feedback.askUser"] = isFeedbackToolActive();
    activeSettings["scout.enabled"] = isScoutActive();
    if (!activeSettings["scout.enabled"]) {
      activeSettings["scout.interceptShell"] = false;
    }
    activeSettings["subagent.enabled"] = isSubagentActive();
    activeSettings["web.enabled"] = isWebActive();
    const output = formatEnhancedSettings(activeSettings, store.getFilePath());
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

    let val = store.get(key);
    let note = "";
    if (key === "feedback.askUser") {
      const active = isFeedbackToolActive();
      if (active !== val) {
        val = active as any;
        note = " (session active)";
      }
    } else if (key === "scout.enabled") {
      const active = isScoutActive();
      if (active !== val) {
        val = active as any;
        note = " (session active)";
      }
    } else if (key === "subagent.enabled") {
      const active = isSubagentActive();
      if (active !== val) {
        val = active as any;
        note = " (session active)";
      }
    } else if (key === "web.enabled") {
      const active = isWebActive();
      if (active !== val) {
        val = active as any;
        note = " (session active)";
      }
    }
    const formatted = `${key} = ${formatSettingValue(key, val)}${note}`;
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
    const rawValue = parts[2];
    const rawVal = rawValue?.toLowerCase();

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
    if (isModelSetting(key)) {
      if (rawVal === MODEL_SETTING_SESSION_VALUE) {
        store.set(key, MODEL_SETTING_SESSION_VALUE);
      } else if (rawValue && await findAvailablePickerModel(ctx, rawValue, ctx.signal).catch(() => undefined)) {
        store.set(key, rawValue);
      } else {
        const msg = "Choose 'session' or an available provider/model from /settings-enhanced.";
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
        return;
      }
    } else if (typeof def.defaultValue === "boolean") {
      const isEnabling = rawVal === "true" || rawVal === "enabled" || rawVal === "1" || rawVal === "on";
      const isDisabling = rawVal === "false" || rawVal === "disabled" || rawVal === "0" || rawVal === "off";

      if (!isEnabling && !isDisabling) {
        const msg = `Invalid value for ${key}. Expected 'enabled' or 'disabled'.`;
        if (ctx.hasUI) ctx.ui.notify(msg, "error");
        else console.error(msg);
        return;
      }

      const changesTools = isToolCacheSetting(key) && TOOL_CACHE_SETTINGS[key].isActive() !== isEnabling;
      if (changesTools) {
        const tokens = ctx.getContextUsage?.()?.tokens ?? 0;
        if (tokens >= TOOL_CACHE_WARNING_TOKENS) {
          const warn = `⚠ Warning: Active context has ~${(tokens / 1000).toFixed(1)}k tokens. ${describeToolCacheChange(key, isEnabling)} Cache misses may increase latency and token costs.`;
          if (ctx.hasUI) ctx.ui.notify(warn, "warning");
          else console.warn(`\x1b[33m${warn}\x1b[0m`);
        }
      }
      store.set(key, isEnabling, { notifyIfUnchanged: changesTools });
      if (isEnabling && key === "scout.interceptShell" && !isScoutActive()) {
        const note = "Set scout.interceptShell = enabled (Note: interceptor remains dormant while Scout search tools are disabled).";
        if (ctx.hasUI) ctx.ui.notify(note, "info");
        else console.log(note);
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
    refreshProviderCatalogs(ctx);
    let availableModels: Awaited<ReturnType<typeof getAvailablePickerModels>> = [];
    try {
      availableModels = await getAvailablePickerModels(ctx);
    } catch {
      ctx.ui.notify("Could not load available models; model choices are unavailable.", "warning");
    }
    await ctx.ui.custom<void>((tui, theme, kb, done) => {
      return new EnhancedSettingsComponent(tui, theme, () => done(undefined), ctx, availableModels, kb);
    });
    return;
  }

  // Non-TUI mode fallback: print settings overview
  const activeSettings = store.getAll();
  activeSettings["feedback.askUser"] = isFeedbackToolActive();
  activeSettings["scout.enabled"] = isScoutActive();
  if (!activeSettings["scout.enabled"]) {
    activeSettings["scout.interceptShell"] = false;
  }
  activeSettings["subagent.enabled"] = isSubagentActive();
  activeSettings["web.enabled"] = isWebActive();
  const output = formatEnhancedSettings(activeSettings, store.getFilePath());
  console.log(output);
}
