import {
  SETTING_DEFINITIONS,
  type EnhancedSettingKey,
  type EnhancedSettings,
  type SettingDefinition,
} from "./types.js";

/**
 * Formats enhanced settings into a clean ANSI-compatible terminal string.
 */
export function formatEnhancedSettings(
  settings: EnhancedSettings,
  filePath?: string,
  options: { color?: boolean; width?: number } = {}
): string {
  const useColor = options.color !== false;
  const bold = (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  const accent = (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s);
  const green = (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s);
  const yellow = (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s);

  const lines: string[] = [];

  lines.push(bold(accent("Enhanced Settings")));
  if (filePath) {
    lines.push(dim(`Config: ${filePath}`));
  }
  lines.push("");

  const categories: Array<SettingDefinition["category"]> = [
    "Tools & Filters",
    "UX & Telemetry",
    "Multi-Account",
    "Subagent",
  ];

  for (const cat of categories) {
    const defs = (Object.values(SETTING_DEFINITIONS) as SettingDefinition[]).filter(
      (d) => d.category === cat
    );
    if (defs.length === 0) continue;

    lines.push(bold(dim(`── ${cat} ──`)));

    for (const def of defs) {
      const rawVal = settings[def.key];
      let valDisplay: string;

      if (typeof rawVal === "boolean") {
        valDisplay = rawVal ? green("[enabled]") : dim("[disabled]");
      } else {
        valDisplay = yellow(`[${rawVal}]`);
      }

      const paddedLabel = def.label.padEnd(26, " ");
      lines.push(`  ${bold(paddedLabel)} ${valDisplay.padEnd(12, " ")} ${dim(def.description)}`);
    }

    lines.push("");
  }

  lines.push(dim("Use /settings-enhanced in TUI mode to toggle settings interactively."));
  return lines.join("\n");
}

/**
 * Formats a value for a specific setting key.
 */
export function formatSettingValue(key: EnhancedSettingKey, value: any): string {
  if (typeof value === "boolean") {
    return value ? "enabled" : "disabled";
  }
  return String(value);
}
