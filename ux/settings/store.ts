import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_ENHANCED_SETTINGS,
  SETTING_DEFINITIONS,
  type EnhancedSettingKey,
  type EnhancedSettings,
} from "./types.js";
import { isScoutActive } from "../../tools/scout/index.js";

type SettingsChangeListener = (settings: EnhancedSettings, changedKey?: EnhancedSettingKey) => void;

/**
 * Persistent store for pi-enhanced extension suite configuration.
 * Persists to ~/.pi/agent/enhanced-settings.json.
 */
export class EnhancedSettingsStore {
  private static instance?: EnhancedSettingsStore;
  private filePath: string;
  private settings: EnhancedSettings;
  private lastMtime = 0;
  private listeners: Set<SettingsChangeListener> = new Set();

  private constructor(customPath?: string) {
    if (customPath) {
      this.filePath = customPath;
    } else if (process.env.PI_CODING_AGENT_DIR) {
      this.filePath = join(process.env.PI_CODING_AGENT_DIR, "enhanced-settings.json");
    } else {
      this.filePath = join(homedir(), ".pi/agent/enhanced-settings.json");
    }

    this.settings = { ...DEFAULT_ENHANCED_SETTINGS };
    this.load();
  }

  public static getInstance(): EnhancedSettingsStore {
    if (!EnhancedSettingsStore.instance) {
      EnhancedSettingsStore.instance = new EnhancedSettingsStore();
    }
    return EnhancedSettingsStore.instance;
  }

  /**
   * Returns path to the settings file.
   */
  public getFilePath(): string {
    return this.filePath;
  }

  /**
   * Retrieves current value for a given setting key.
   */
  public get<K extends EnhancedSettingKey>(key: K): EnhancedSettings[K] {
    this.checkExternalChanges();
    return this.settings[key];
  }

  /**
   * Updates a single setting and persists to disk.
   */
  public set<K extends EnhancedSettingKey>(key: K, value: EnhancedSettings[K]): void {
    this.checkExternalChanges();
    if (this.settings[key] === value) return;

    this.settings[key] = value;
    this.save();
    this.notify(key);
  }

  /**
   * Returns a copy of all current settings.
   */
  public getAll(): EnhancedSettings {
    this.checkExternalChanges();
    return { ...this.settings };
  }

  /**
   * Resets all settings to their default values.
   */
  public reset(): void {
    this.settings = { ...DEFAULT_ENHANCED_SETTINGS };
    this.save();
    this.notify();
  }

  /**
   * Subscribes to setting change events.
   */
  public onChange(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(changedKey?: EnhancedSettingKey): void {
    const copy = { ...this.settings };
    for (const listener of this.listeners) {
      try {
        listener(copy, changedKey);
      } catch (err) {
        console.error("[EnhancedSettingsStore] Listener error:", err);
      }
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) {
        this.save();
        return;
      }

      const stat = statSync(this.filePath);
      this.lastMtime = stat.mtimeMs;
      const content = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(content);

      if (parsed && typeof parsed === "object") {
        for (const key of Object.keys(SETTING_DEFINITIONS) as EnhancedSettingKey[]) {
          if (key in parsed) {
            const rawVal = parsed[key];
            const def = SETTING_DEFINITIONS[key];

            const target = this.settings as Record<string, any>;
            if (typeof def.defaultValue === "boolean") {
              if (typeof rawVal === "boolean") {
                target[key] = rawVal;
              } else if (rawVal === "enabled" || rawVal === "true") {
                target[key] = true;
              } else if (rawVal === "disabled" || rawVal === "false") {
                target[key] = false;
              }
            } else if (
              (key === "git.commitModel" || key === "session.titleModel") &&
              typeof rawVal === "string" &&
              rawVal.trim()
            ) {
              target[key] = rawVal.trim();
            } else if (key === "usage.contextFormat" && (rawVal === "default" || rawVal === "alternate")) {
              target[key] = rawVal === "default" ? "pi" : "pi-enhanced";
            } else if (def.options.includes(rawVal)) {
              target[key] = rawVal;
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[EnhancedSettingsStore] Failed to read ${this.filePath}, using defaults:`, err);
      this.settings = { ...DEFAULT_ENHANCED_SETTINGS };
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const json = JSON.stringify(this.settings, null, 2);
      writeFileSync(this.filePath, json, { encoding: "utf-8", mode: 0o600 });
      const stat = statSync(this.filePath);
      this.lastMtime = stat.mtimeMs;
    } catch (err) {
      console.error(`[EnhancedSettingsStore] Failed to write ${this.filePath}:`, err);
    }
  }

  private checkExternalChanges(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const stat = statSync(this.filePath);
      if (stat.mtimeMs > this.lastMtime) {
        this.load();
        this.notify();
      }
    } catch {
      // Ignore check errors
    }
  }
}
