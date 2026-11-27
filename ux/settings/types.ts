import { SESSION_THINKING_VALUE, THINKING_LEVELS, type SessionThinkingSetting } from "../thinking-levels.js";

export type SubagentExecutionMode = "background" | "sync";
export type ContextUsageFormat = "pi" | "pi-enhanced" | "off";

export const MODEL_SETTING_SESSION_VALUE = "session";
export const MODEL_SETTING_SESSION_LABEL = "Use session model";

export function isModelSetting(key: EnhancedSettingKey): key is "git.commitModel" | "session.titleModel" | "subagent.model" {
  return key === "git.commitModel" || key === "session.titleModel" || key === "subagent.model";
}

export const THINKING_SETTING_MODEL_KEYS = {
  "subagent.thinkingLevel": "subagent.model",
  "git.thinkingLevel": "git.commitModel",
} as const;

export function isThinkingSetting(key: EnhancedSettingKey): key is keyof typeof THINKING_SETTING_MODEL_KEYS {
  return Object.hasOwn(THINKING_SETTING_MODEL_KEYS, key);
}

export interface EnhancedSettings {
  /** In-memory code search engine exposing find and grep tools. */
  "scout.enabled": boolean;
  /** Transparently intercept shell grep/find/rg commands and steer LLM to scout. */
  "scout.interceptShell": boolean;
  /** Apply Git's ignore rules in workspace searches (fixed exclusions still apply). */
  "scout.respectGitIgnore": boolean;
  /** Index hidden directories except fixed exclusions such as .git. */
  "scout.includeHidden": boolean;
  /** Multi-provider web search and content fetch tools (web_search, web_fetch). */
  "web.enabled": boolean;
  /** Enable autonomous isolated subagent execution (subagent, /subagent, /jobs). */
  "subagent.enabled": boolean;
  /** Default execution mode for /subagent tasks (background or sync). */
  "subagent.defaultMode": SubagentExecutionMode;
  /** Default turn limit for new subagents (0 disables the limit). */
  "subagent.maxTurns": number;
  /** Default timeout in milliseconds for new subagents (0 disables the limit). */
  "subagent.timeoutMs": number;
  /** Model used by new subagents, or "session" for the active Pi model. */
  "subagent.model": string;
  /** Thinking effort used by new subagents, or "session" to inherit it. */
  "subagent.thinkingLevel": SessionThinkingSetting;
  /** Allow LLM to ask user clarification questions and 3 choices interactively. */
  "feedback.askUser": boolean;
  /** Enable token output compressor for noisy bash/powershell outputs. */
  "compressor.enabled": boolean;
  /** Model used by the autonomous Git commit assistant, or "session" for the active Pi model. */
  "git.commitModel": string;
  /** Thinking effort for commit and summary, or "session" to inherit it. */
  "git.thinkingLevel": SessionThinkingSetting;

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
  /** Generate a session title once from its first user message. */
  "session.autoTitle": boolean;
  /** Model used to generate session titles, or "session" for the active Pi model. */
  "session.titleModel": string;
  /** Automatically failover to next eligible account on HTTP 429 rate limit. */
  "balancer.failoverOn429": boolean;
  /** Balance account selection using weekly reset pace and perishable credits. */
  "balancer.paceBalancing": boolean;
}

export type EnhancedSettingKey = keyof EnhancedSettings;

const NUMERIC_SETTING_MAX = {
  "subagent.maxTurns": Number.MAX_SAFE_INTEGER,
  "subagent.timeoutMs": 2_147_483_647, // Node's largest supported setTimeout delay
} as const;

type NumericSettingKey = keyof typeof NUMERIC_SETTING_MAX;

export function isNumericSetting(key: EnhancedSettingKey): key is NumericSettingKey {
  return Object.hasOwn(NUMERIC_SETTING_MAX, key);
}

export function parseNumericSetting(key: NumericSettingKey, raw: unknown): number | undefined {
  const value = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= NUMERIC_SETTING_MAX[key]) {
    return value;
  }
  return undefined;
}

export function numericSettingHint(key: NumericSettingKey): string {
  return `Enter a whole number from 0 to ${NUMERIC_SETTING_MAX[key]} (0 means no limit).`;
}

export interface SettingDefinition<K extends EnhancedSettingKey = EnhancedSettingKey> {
  key: K;
  label: string;
  category: "Agent Tools" | "UX & Telemetry" | "Multi-Account";
  description: string;
  defaultValue: EnhancedSettings[K];
  options: string[];
}

export const SETTING_DEFINITIONS: { [K in EnhancedSettingKey]: SettingDefinition<K> } = {
  // ── Agent Tools ──
  "scout.enabled": {
    key: "scout.enabled",
    label: "Scout Search Tools",
    category: "Agent Tools",
    description: "In-memory search tools (find, grep). Toggling mid-session can invalidate the prompt cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "scout.interceptShell": {
    key: "scout.interceptShell",
    label: "Scout Shell Interceptor",
    category: "Agent Tools",
    description: "Intercept shell grep/find/rg commands and steer LLM to fast in-memory scout tools",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "scout.respectGitIgnore": {
    key: "scout.respectGitIgnore",
    label: "Scout Git Ignore Rules",
    category: "Agent Tools",
    description: "Honor .gitignore, Git exclude files and tracked exceptions in workspace searches",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "scout.includeHidden": {
    key: "scout.includeHidden",
    label: "Scout Hidden Directories",
    category: "Agent Tools",
    description: "Include hidden workspace directories; fixed exclusions and Git ignore rules still apply",
    defaultValue: false,
    options: ["enabled", "disabled"],
  },
  "web.enabled": {
    key: "web.enabled",
    label: "Web Access Tools",
    category: "Agent Tools",
    description: "Multi-provider web search & extraction (web_search, web_fetch). Toggling mid-session can invalidate the prompt cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "subagent.enabled": {
    key: "subagent.enabled",
    label: "Subagent Tools",
    category: "Agent Tools",
    description: "Autonomous isolated subagent execution (subagent, /subagent, /jobs). Toggling mid-session can invalidate the prompt cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "subagent.defaultMode": {
    key: "subagent.defaultMode",
    label: "Subagent Default Mode",
    category: "Agent Tools",
    description: "Default execution mode for isolated subagents (non-blocking background vs blocking sync)",
    defaultValue: "background",
    options: ["background", "sync"],
  },
  "subagent.maxTurns": {
    key: "subagent.maxTurns",
    label: "Subagent Max Turns",
    category: "Agent Tools",
    description: "Default model-turn limit for new subagents (0 means no limit)",
    defaultValue: 25,
    options: [],
  },
  "subagent.timeoutMs": {
    key: "subagent.timeoutMs",
    label: "Subagent Timeout (ms)",
    category: "Agent Tools",
    description: "Default execution timeout in milliseconds for new subagents (0 means no limit)",
    defaultValue: 300_000,
    options: [],
  },
  "subagent.model": {
    key: "subagent.model",
    label: "Subagent Model",
    category: "Agent Tools",
    description: "Model for the subagent tool and /subagent; choose Use session model to follow the active Pi model",
    defaultValue: MODEL_SETTING_SESSION_VALUE,
    options: [MODEL_SETTING_SESSION_VALUE],
  },
  "subagent.thinkingLevel": {
    key: "subagent.thinkingLevel",
    label: "Subagent Thinking",
    category: "Agent Tools",
    description: "Thinking level for the subagent tool and /subagent. The saved level is adjusted to what the model supports",
    defaultValue: SESSION_THINKING_VALUE,
    options: [SESSION_THINKING_VALUE, ...THINKING_LEVELS],
  },
  "feedback.askUser": {
    key: "feedback.askUser",
    label: "Ask User Tools",
    category: "Agent Tools",
    description: "Allow LLM to prompt user for feedback and 3 choices. Toggling mid-session can invalidate the prompt cache",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "compressor.enabled": {
    key: "compressor.enabled",
    label: "Output Compressor",
    category: "Agent Tools",
    description: "Compress noisy bash/powershell outputs (tests, git, linters) before model context",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "git.commitModel": {
    key: "git.commitModel",
    label: "Git Agent Model",
    category: "Agent Tools",
    description: "Model for /commit, /git commit, and /git summary; choose Use session model to follow the active Pi model",
    defaultValue: MODEL_SETTING_SESSION_VALUE,
    options: [MODEL_SETTING_SESSION_VALUE],
  },

  "git.thinkingLevel": {
    key: "git.thinkingLevel",
    label: "Git Agent Thinking",
    category: "Agent Tools",
    description: "Thinking level for /commit, /git commit, and /git summary. The saved level is adjusted to what the model supports",
    defaultValue: SESSION_THINKING_VALUE,
    options: [SESSION_THINKING_VALUE, ...THINKING_LEVELS],
  },

  // ── UX & Telemetry ──
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
  "session.autoTitle": {
    key: "session.autoTitle",
    label: "Automatic Session Titles",
    category: "UX & Telemetry",
    description: "Generate a short, action-oriented title from the first user message using the configured model (extra model call)",
    defaultValue: true,
    options: ["enabled", "disabled"],
  },
  "session.titleModel": {
    key: "session.titleModel",
    label: "Title Generation Model",
    category: "UX & Telemetry",
    description: "Model for automatic session titles; choose Use session model to follow the active Pi model",
    defaultValue: MODEL_SETTING_SESSION_VALUE,
    options: [MODEL_SETTING_SESSION_VALUE],
  },

  // ── Multi-Account ──
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
};

export const DEFAULT_ENHANCED_SETTINGS: EnhancedSettings = {
  "scout.enabled": SETTING_DEFINITIONS["scout.enabled"].defaultValue,
  "scout.interceptShell": SETTING_DEFINITIONS["scout.interceptShell"].defaultValue,
  "scout.respectGitIgnore": SETTING_DEFINITIONS["scout.respectGitIgnore"].defaultValue,
  "scout.includeHidden": SETTING_DEFINITIONS["scout.includeHidden"].defaultValue,
  "web.enabled": SETTING_DEFINITIONS["web.enabled"].defaultValue,
  "subagent.enabled": SETTING_DEFINITIONS["subagent.enabled"].defaultValue,
  "subagent.defaultMode": SETTING_DEFINITIONS["subagent.defaultMode"].defaultValue,
  "subagent.maxTurns": SETTING_DEFINITIONS["subagent.maxTurns"].defaultValue,
  "subagent.timeoutMs": SETTING_DEFINITIONS["subagent.timeoutMs"].defaultValue,
  "subagent.model": SETTING_DEFINITIONS["subagent.model"].defaultValue,
  "subagent.thinkingLevel": SETTING_DEFINITIONS["subagent.thinkingLevel"].defaultValue,
  "feedback.askUser": SETTING_DEFINITIONS["feedback.askUser"].defaultValue,
  "compressor.enabled": SETTING_DEFINITIONS["compressor.enabled"].defaultValue,
  "git.commitModel": SETTING_DEFINITIONS["git.commitModel"].defaultValue,
  "git.thinkingLevel": SETTING_DEFINITIONS["git.thinkingLevel"].defaultValue,
  "usage.showFooter": SETTING_DEFINITIONS["usage.showFooter"].defaultValue,
  "usage.contextFormat": SETTING_DEFINITIONS["usage.contextFormat"].defaultValue,
  "timer.showSummary": SETTING_DEFINITIONS["timer.showSummary"].defaultValue,
  "timer.showWorkingTelemetry": SETTING_DEFINITIONS["timer.showWorkingTelemetry"].defaultValue,
  "continue.dotShortcut": SETTING_DEFINITIONS["continue.dotShortcut"].defaultValue,
  "session.autoTitle": SETTING_DEFINITIONS["session.autoTitle"].defaultValue,
  "session.titleModel": SETTING_DEFINITIONS["session.titleModel"].defaultValue,
  "balancer.failoverOn429": SETTING_DEFINITIONS["balancer.failoverOn429"].defaultValue,
  "balancer.paceBalancing": SETTING_DEFINITIONS["balancer.paceBalancing"].defaultValue,
};
