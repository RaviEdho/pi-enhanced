import { isFeedbackToolActive } from "../../tools/feedback/index.js";
import { isScoutActive } from "../../tools/scout/register.js";
import { isSubagentActive } from "../../tools/subagent/index.js";
import { isWebActive } from "../../tools/web/index.js";
import type { EnhancedSettingKey } from "./types.js";

export const TOOL_CACHE_WARNING_TOKENS = 10_000;

export const TOOL_CACHE_SETTINGS = {
  "feedback.askUser": { label: "Ask User Tools ('ask_user')", isActive: isFeedbackToolActive },
  "scout.enabled": { label: "Scout Search Tools ('find', 'grep')", isActive: isScoutActive },
  "subagent.enabled": {
    label: "Subagent Tools ('subagent', 'subagent_status', 'subagent_list', 'subagent_cancel')",
    isActive: isSubagentActive,
  },
  "web.enabled": { label: "Web Access Tools ('web_search', 'web_fetch')", isActive: isWebActive },
};

export type ToolCacheSettingKey = keyof typeof TOOL_CACHE_SETTINGS;

export function isToolCacheSetting(key: EnhancedSettingKey): key is ToolCacheSettingKey {
  return Object.hasOwn(TOOL_CACHE_SETTINGS, key);
}

export function describeToolCacheChange(key: ToolCacheSettingKey, enabled: boolean): string {
  const change = enabled ? "Enabling" : "Disabling";
  const effect = enabled ? "adds" : "removes";
  return `${change} ${TOOL_CACHE_SETTINGS[key].label} mid-session ${effect} tool definitions and can invalidate your prefix prompt cache.`;
}
