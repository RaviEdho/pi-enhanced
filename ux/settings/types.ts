export type SubagentExecutionMode = "background" | "sync";
export type ContextUsageFormat = "pi" | "pi-enhanced" | "off";

export interface EnhancedSettings {
  /** Enable token output compressor for noisy bash/powershell outputs. */
  "compressor.enabled": boolean;
  /** In-memory code search engine exposing find, grep, and multi_grep tools. */
  "scout.enabled": boolean;
  /** Transparently intercept shell grep/find/rg commands and steer LLM to scout. */
  "scout.interceptShell": boolean;
  /** Allow LLM to ask user clarification questions and 3 choices interactively. */
  "feedback.askUser": boolean;
  /** Display live quota consumption and time progress bars in status footer. */
  "usage.showFooter": boolean;
  /** Format of context window usage in status footer (default, alternate, or off). */
  "usage.contextFormat": ContextUsageFormat;
  /** Append turn summary telemetry (duration, tokens, speed) after settled turns. */
  "timer.showSummary": boolean;
  /** Display live duration, token count, TTFT, and decoding speed in the working spinner. */
  "timer.showWorkingTelemetry": boolean;
  /** Enable literal dot "." prompt continuation shortcut. */
  "continue.dotShortcut": boolean;
  /** Automatically failover to next eligible account on HTTP 429 rate limit. */
  "balancer.failoverOn429": boolean;
  /** Balance account selection using weekly reset pace and perishable credits. */
  "balancer.paceBalancing": boolean;
  /** Enable autonomous isolated subagent execution (subagent, /subagent, /jobs). */
  "subagent.enabled": boolean;
  /** Default execution mode for /subagent tasks (background or sync). */
  "subagent.defaultMode": SubagentExecutionMode;
}

export type EnhancedSettingKey = keyof EnhancedSettings;

export interface SettingDefinition<K extends EnhancedSettingKey = EnhancedSettingKey> {
  key: K;
  label: string;
  category: "Tools & Filters" | "UX & Telemetry" | "Multi-Account" | "Subagent";
  description: string;
  defaultValue: EnhancedSettings[K];
  options: string[];
}

export const SETTING_DEFINITIONS: { [K in EnhancedSettingKey]: SettingDefinition<K> } = {
  "compressor.enabled": {
    key: "compressor.enabled",
    label: "Output Compressor",
    category: "Tools & Filters",
    description: "Compress noisy bash/powershell outputs (tests, git, linters) before model context",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "scout.enabled": {
    key: "scout.enabled",
    label: "Scout Search Tools",
    category: "Tools & Filters",
    description: "In-memory search tools (find, grep, multi_grep). Disabling mid-session drops schemas & busts cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "scout.interceptShell": {
    key: "scout.interceptShell",
    label: "Scout Shell Interceptor",
    category: "Tools & Filters",
    description: "Intercept shell grep/find/rg commands and steer LLM to fast in-memory scout tools",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "feedback.askUser": {
    key: "feedback.askUser",
    label: "Interactive Ask User",
    category: "Tools & Filters",
    description: "Allow LLM to prompt user for feedback and 3 choices. Disabling mid-session drops schema & busts cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "usage.showFooter": {
    key: "usage.showFooter",
    label: "Quota Status Footer",
    category: "UX & Telemetry",
    description: "Show live multi-account quota bars and elapsed time progress in the status footer",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "usage.contextFormat": {
    key: "usage.contextFormat",
    label: "Footer Context Usage",
    category: "UX & Telemetry",
    description: "Format of context usage in status footer: pi-enhanced (45k/200k), pi (23.5%/200k), or off",
    defaultValue: "pi-enhanced",
    options: ["pi-enhanced", "pi", "off"],
  },
  "timer.showSummary": {
    key: "timer.showSummary",
    label: "Turn Summary Telemetry",
    category: "UX & Telemetry",
    description: "Append compact duration, token count, and speed telemetry in transcript after settled turns",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "timer.showWorkingTelemetry": {
    key: "timer.showWorkingTelemetry",
    label: "Live Working Telemetry",
    category: "UX & Telemetry",
    description: "Display live duration, token count, TTFT, and decoding speed in the working spinner",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "continue.dotShortcut": {
    key: "continue.dotShortcut",
    label: "Continue Shortcut (.)",
    category: "UX & Telemetry",
    description: "Trigger seamless continuation without prompt bubbles by sending a literal dot '.'",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "balancer.failoverOn429": {
    key: "balancer.failoverOn429",
    label: "429 Account Failover",
    category: "Multi-Account",
    description: "Automatically switch to another eligible account on HTTP 429 rate limit or quota exhaustion",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "balancer.paceBalancing": {
    key: "balancer.paceBalancing",
    label: "Weekly Pace Balancing",
    category: "Multi-Account",
    description: "Balance requests across accounts based on weekly quota reset pace and perishable credits",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "subagent.enabled": {
    key: "subagent.enabled",
    label: "Subagent Routine",
    category: "Subagent",
    description: "Autonomous isolated subagent execution (subagent, /subagent, /jobs). Disabling mid-session drops schemas & busts cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "subagent.defaultMode": {
    key: "subagent.defaultMode",
    label: "Subagent Default Mode",
    category: "Subagent",
    description: "Default execution mode for isolated subagents (non-blocking background vs blocking sync)",
    defaultValue: "background",
    options: ["background", "sync"],
  },
};

export const DEFAULT_ENHANCED_SETTINGS: EnhancedSettings = {
  "compressor.enabled": SETTING_DEFINITIONS["compressor.enabled"].defaultValue,
  "scout.enabled": SETTING_DEFINITIONS["scout.enabled"].defaultValue,
  "scout.interceptShell": SETTING_DEFINITIONS["scout.interceptShell"].defaultValue,
  "feedback.askUser": SETTING_DEFINITIONS["feedback.askUser"].defaultValue,
  "usage.showFooter": SETTING_DEFINITIONS["usage.showFooter"].defaultValue,
  "usage.contextFormat": SETTING_DEFINITIONS["usage.contextFormat"].defaultValue,
  "timer.showSummary": SETTING_DEFINITIONS["timer.showSummary"].defaultValue,
  "timer.showWorkingTelemetry": SETTING_DEFINITIONS["timer.showWorkingTelemetry"].defaultValue,
  "continue.dotShortcut": SETTING_DEFINITIONS["continue.dotShortcut"].defaultValue,
  "balancer.failoverOn429": SETTING_DEFINITIONS["balancer.failoverOn429"].defaultValue,
  "balancer.paceBalancing": SETTING_DEFINITIONS["balancer.paceBalancing"].defaultValue,
  "subagent.enabled": SETTING_DEFINITIONS["subagent.enabled"].defaultValue,
  "subagent.defaultMode": SETTING_DEFINITIONS["subagent.defaultMode"].defaultValue,
};
