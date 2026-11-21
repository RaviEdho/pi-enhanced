import type { Model, Api } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  getKeybindings,
  Input,
  SettingsList,
  Text,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { refreshProviderCatalogs } from "../../providers/refresh.js";
import { isFeedbackToolActive } from "../../tools/feedback/index.js";
import { isScoutActive } from "../../tools/scout/register.js";
import { isSubagentActive } from "../../tools/subagent/index.js";
import { isWebActive } from "../../tools/web/index.js";
import { DialogFrame, renderDialogActions } from "../dialog.js";
import { ModelPickerComponent } from "../model-picker.js";
import { formatThinkingOverride, getThinkingLevelOptions, SESSION_THINKING_LABEL, SESSION_THINKING_VALUE, THINKING_LEVELS } from "../thinking-levels.js";
import { EnhancedSettingsStore } from "./store.js";
import {
  TOOL_CACHE_SETTINGS,
  TOOL_CACHE_WARNING_TOKENS,
  describeToolCacheChange,
  isToolCacheSetting,
  type ToolCacheSettingKey,
} from "./tool-cache.js";
import {
  MODEL_SETTING_SESSION_LABEL,
  MODEL_SETTING_SESSION_VALUE,
  SETTING_DEFINITIONS,
  THINKING_SETTING_MODEL_KEYS,
  isModelSetting,
  isThinkingSetting,
  type EnhancedSettingKey,
  type EnhancedSettings,
  type SettingDefinition,
} from "./types.js";

type BooleanSettingKey = {
  [K in EnhancedSettingKey]: EnhancedSettings[K] extends boolean ? K : never;
}[EnhancedSettingKey];

interface CacheWarningState {
  settingKey: ToolCacheSettingKey;
  contextTokens: number;
  enabled: boolean;
  selectedOption: number; // 0 = Keep current state, 1 = Apply change
}

/**
 * Interactive settings component for pi-enhanced.
 * Matches Pi's native `/settings` modal conventions:
 * - Content-sized native borders, lists, and inline submenus
 * - Built-in search input with real-time fuzzy filtering
 * - Native keyboard navigation (Tab, Left/Right cycling, Home/End, Esc)
 */
export class EnhancedSettingsComponent implements Component {
  readonly capturesViewportInput = true;
  private tui: TUI;
  private theme: any;
  private onDone: () => void;
  private ctx?: ExtensionCommandContext;
  private store: EnhancedSettingsStore;
  private settingsList: SettingsList;
  private items: SettingItem[];
  private cacheWarning?: CacheWarningState;
  private frame: DialogFrame;
  private hasFocus = false;
  private modelMenu?: ModelPickerComponent;
  private bodyIdentity?: string;
  private listStart = 3;

  constructor(
    tui: TUI,
    theme: any,
    onDone: () => void,
    ctx?: ExtensionCommandContext,
    private readonly availableModels: readonly Model<Api>[] = [],
    private readonly keybindings?: KeybindingsManager
  ) {
    this.tui = tui;
    this.theme = theme;
    this.frame = new DialogFrame(tui, theme);
    this.onDone = onDone;
    this.ctx = ctx;
    this.store = EnhancedSettingsStore.getInstance();
    const scoutActive = isScoutActive();
    const feedbackActive = isFeedbackToolActive();
    const subagentActive = isSubagentActive();
    const webActive = isWebActive();
    const modelChoices: SelectItem[] = [
      {
        value: MODEL_SETTING_SESSION_LABEL,
        label: MODEL_SETTING_SESSION_LABEL,
        description: "Follow the model currently selected in the Pi session",
      },
      ...availableModels.map((model) => ({
        value: `${model.provider}/${model.id}`,
        label: `${model.provider}/${model.id}`,
        description: model.name,
      })).sort((a, b) => a.label.localeCompare(b.label)),
    ];

    // Build setting items mapped from definitions
    this.items = (
      Object.values(SETTING_DEFINITIONS) as SettingDefinition[]
    ).map((def) => {
      let currentRaw = this.store.get(def.key);

      // Reflect session-persisted tool states so settings view matches active session reality
      if (def.key === "feedback.askUser") {
        currentRaw = feedbackActive;
      } else if (def.key === "scout.enabled") {
        currentRaw = scoutActive;
      } else if (def.key === "subagent.enabled") {
        currentRaw = subagentActive;
      } else if (def.key === "web.enabled") {
        currentRaw = webActive;
      }

      let currentValue =
        typeof currentRaw === "boolean"
          ? currentRaw
            ? "enabled"
            : "disabled"
          : String(currentRaw);

      let options = [...def.options];
      let description = def.description;
      let submenu: SettingItem["submenu"];

      if (isModelSetting(def.key)) {
        options = [];
        currentValue = currentRaw === MODEL_SETTING_SESSION_VALUE
          ? MODEL_SETTING_SESSION_LABEL
          : String(currentRaw);
        const unavailableChoice = modelChoices.some((choice) => choice.value === currentValue)
          ? undefined
          : {
              value: currentValue,
              label: `${currentValue} (unavailable)`,
              description: "This saved model is not currently available",
            };
        if (unavailableChoice) currentValue = unavailableChoice.label;
        submenu = (currentValue, done) => {
          const unavailable = unavailableChoice?.label === currentValue ? unavailableChoice : undefined;
          const picker = new ModelPickerComponent(this.tui, this.theme,
            this.keybindings ?? { matches: (data, action) => getKeybindings().matches(data, action as any) }, {
              title: `Select ${def.label}`,
              choices: unavailable ? [...modelChoices, unavailable] : modelChoices,
              currentValue: unavailable?.value ?? currentValue,
              refresh: this.ctx ? refreshProviderCatalogs(this.ctx) : undefined,
              bordered: false,
            }, (value) => {
              picker.dispose();
              this.modelMenu = undefined;
              done(value === unavailable?.value ? undefined : value);
            });
          picker.focused = this.hasFocus;
          this.modelMenu = picker;
          return picker;
        };
      } else if (isThinkingSetting(def.key)) {
        ({ currentValue, values: options } = this.getThinkingItemState(def.key));
      } else if (def.key === "scout.interceptShell" && !scoutActive) {
        description =
          "Intercept shell grep/find/rg commands (Dormant: requires Scout Search Tools to be enabled)";
      } else if (def.key === "subagent.defaultMode" && !subagentActive) {
        description =
          "Default execution mode for isolated subagents (Dormant: requires Subagent Routine to be enabled)";
      }

      return {
        id: def.key,
        label: def.label,
        description,
        currentValue,
        values: options,
        ...(submenu ? { submenu } : {}),
      };
    });

    const maxVisible = this.maxVisibleRows();
    const listTheme = getSettingsListTheme();

    this.settingsList = new SettingsList(
      this.items,
      maxVisible,
      listTheme,
      (id: string, newValue: string) => {
        this.handleSettingChange(id, newValue);
      },
      () => {
        this.onDone();
      },
      { enableSearch: true } // Native search filter enabled
    );
  }

  public get focused(): boolean {
    return this.hasFocus;
  }

  public set focused(value: boolean) {
    this.hasFocus = value;
    const searchInput = (this.settingsList as any)?.searchInput as Input | undefined;
    if (searchInput) searchInput.focused = value;
    if (this.modelMenu) this.modelMenu.focused = value;
  }

  public invalidate(): void {
    this.settingsList.invalidate();
    (this.settingsList as any).searchInput?.invalidate();
  }

  public dispose(): void {
    this.modelMenu?.dispose();
  }

  public render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    if (this.cacheWarning) {
      const warning = this.cacheWarning;
      const content: string[] = [];
      const paragraph = (text: string, color: string) => {
        content.push(...wrapTextWithAnsi(this.theme.fg(color, text), innerWidth)
          .map((line) => `  ${line}`));
      };
      paragraph(`Active context has ~${(warning.contextTokens / 1000).toFixed(1)}k tokens (≥ ${TOOL_CACHE_WARNING_TOKENS / 1000}k threshold).`, "warning");
      content.push("");
      paragraph(describeToolCacheChange(warning.settingKey, warning.enabled), "text");
      content.push("");
      paragraph("Cache misses may increase latency and token costs on subsequent requests.", "dim");
      const labels = warning.enabled
        ? ["Keep disabled (recommended)", "Proceed and enable anyway"]
        : ["Keep enabled (recommended)", "Proceed and disable anyway"];
      const actions = renderDialogActions(labels, warning.selectedOption, width);
      const actionFocusLine = warning.selectedOption;
      this.resetScrollForDetails(`warning:${warning.settingKey}:${warning.enabled}`);
      return this.frame.render(width, {
        title: "Prompt Cache Invalidation Warning",
        content,
        actions,
        actionFocusLine,
        hints: ["↑↓ toggle", "Enter confirm", "Esc cancel"],
      });
    }

    const border = new DynamicBorder().render(width);
    if (this.modelMenu) this.modelMenu.focused = this.hasFocus;
    else (this.settingsList as any).searchInput.focused = this.hasFocus;
    const listLines = this.settingsList.render(width).map((line) => {
      if (this.modelMenu) return line;
      const clean = stripTerminalSequences(line);
      if ((!this.isScoutCurrentlyEnabled() && clean.includes("Scout Shell Interceptor")) ||
          (!this.isSubagentCurrentlyEnabled() && clean.includes("Subagent Default Mode"))) {
        return this.theme.fg("dim", clean);
      }
      return line;
    });
    // Keep native list, descriptions, search, and submenu rows intact. In
    // particular, do not move descriptions above the list or pad pages.
    const header = [...border,
      ...(!this.modelMenu ? [...new Text(this.theme.bold(this.theme.fg("accent", "Enhanced Settings")), 0, 0).render(width), ""] : [])];
    this.listStart = header.length;
    return [...header, ...listLines, ...border];
  }

  public handleInput(data: string): boolean {
    if (this.cacheWarning && this.frame.handleInput(data)) return true;
    // Intercept input during cache warning confirmation
    if (this.cacheWarning) {
      if (
        matchesKey(data, "escape") ||
        matchesKey(data, "esc") ||
        data === "\x1b" ||
        data === "\x03"
      ) {
        this.cacheWarning = undefined;
        this.tui.requestRender();
        return true;
      }

      if (
        matchesKey(data, "up") ||
        matchesKey(data, "down") ||
        matchesKey(data, "left") ||
        matchesKey(data, "right") ||
        data === "\t" ||
        data === "\x1b[Z" ||
        data === "j" ||
        data === "k"
      ) {
        this.cacheWarning.selectedOption = 1 - this.cacheWarning.selectedOption;
        this.tui.requestRender();
        return true;
      }

      if (matchesKey(data, "enter") || data === "\r" || data === "\n" || data === " ") {
        const { settingKey, enabled, selectedOption } = this.cacheWarning;
        this.cacheWarning = undefined;
        if (selectedOption === 1) {
          this.settingsList.updateValue(settingKey, enabled ? "enabled" : "disabled");
          this.applyBooleanSetting(settingKey, enabled);
        }
        this.tui.requestRender();
        return true;
      }

      return true;
    }

    const anyList = this.settingsList as any;
    if (anyList.submenuComponent) {
      this.settingsList.handleInput(data);
      this.tui.requestRender();
      return true;
    }
    const searchVal: string = anyList.searchInput?.getValue?.() ?? "";

    // Escape handling:
    // If search filter has text, clear search input first; if already empty, close dialog
    if (
      matchesKey(data, "escape") ||
      matchesKey(data, "esc") ||
      data === "\x1b"
    ) {
      if (searchVal.length > 0) {
        anyList.searchInput?.setValue?.("");
        anyList.applyFilter?.("");
        this.tui.requestRender();
        return true;
      }
      this.onDone();
      return true;
    }

    // Ctrl+C: Cancel / exit immediately
    if (data === "\x03") {
      this.onDone();
      return true;
    }

    const displayItems: SettingItem[] = anyList.getDisplayItems
      ? anyList.getDisplayItems()
      : this.items;

    // Tab: Advance selection down
    if (data === "\t" || data === "\x09") {
      if (displayItems.length > 0) {
        anyList.selectedIndex = (anyList.selectedIndex + 1) % displayItems.length;
        this.skipUnselectableItems("down");
        this.tui.requestRender();
        return true;
      }
    }

    // Shift+Tab: Advance selection up
    if (data === "\x1b[Z") {
      if (displayItems.length > 0) {
        anyList.selectedIndex =
          (anyList.selectedIndex - 1 + displayItems.length) % displayItems.length;
        this.skipUnselectableItems("up");
        this.tui.requestRender();
        return true;
      }
    }

    // Left Arrow (\x1b[D): Cycle value backward when not typing inside search query
    if (data === "\x1b[D" && searchVal.length === 0) {
      const currentItem = displayItems[anyList.selectedIndex];
      if (currentItem?.id === "scout.interceptShell" && !this.isScoutCurrentlyEnabled()) {
        return true;
      }
      if (currentItem?.id === "subagent.defaultMode" && !this.isSubagentCurrentlyEnabled()) {
        return true;
      }
      if (currentItem && currentItem.values && currentItem.values.length > 1) {
        const curIdx = currentItem.values.indexOf(currentItem.currentValue);
        const prevIdx =
          (curIdx - 1 + currentItem.values.length) % currentItem.values.length;
        const newVal = currentItem.values[prevIdx];
        currentItem.currentValue = newVal;
        this.handleSettingChange(currentItem.id, newVal);
        this.tui.requestRender();
        return true;
      }
    }

    // Right Arrow (\x1b[C): Cycle value forward when not typing inside search query
    if (data === "\x1b[C" && searchVal.length === 0) {
      const currentItem = displayItems[anyList.selectedIndex];
      if (currentItem?.id === "scout.interceptShell" && !this.isScoutCurrentlyEnabled()) {
        return true;
      }
      if (currentItem?.id === "subagent.defaultMode" && !this.isSubagentCurrentlyEnabled()) {
        return true;
      }
      if (currentItem && currentItem.values && currentItem.values.length > 1) {
        const curIdx = currentItem.values.indexOf(currentItem.currentValue);
        const nextIdx = (curIdx + 1) % currentItem.values.length;
        const newVal = currentItem.values[nextIdx];
        currentItem.currentValue = newVal;
        this.handleSettingChange(currentItem.id, newVal);
        this.tui.requestRender();
        return true;
      }
    }

    // Home (\x1b[H or \x1b[1~): Jump to first item (when search input is empty)
    if ((data === "\x1b[H" || data === "\x1b[1~") && searchVal.length === 0) {
      anyList.selectedIndex = 0;
      this.tui.requestRender();
      return true;
    }

    // End (\x1b[F or \x1b[4~): Jump to last item (when search input is empty)
    if ((data === "\x1b[F" || data === "\x1b[4~") && searchVal.length === 0) {
      anyList.selectedIndex = Math.max(0, displayItems.length - 1);
      this.tui.requestRender();
      return true;
    }

    // Delegate to native SettingsList (handles text typing, arrow navigation, Enter/Space)
    const isMovingUp = matchesKey(data, "up") || data === "k" || data === "\x1b[A";
    const isMovingDown = matchesKey(data, "down") || data === "j" || data === "\x1b[B";

    this.settingsList.handleInput?.(data);

    if (isMovingUp) {
      this.skipUnselectableItems("up");
    } else if (isMovingDown) {
      this.skipUnselectableItems("down");
    }

    this.tui.requestRender();
    return true;
  }

  public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.cacheWarning) return this.frame.handleMouse(event);
    const offset = this.listStart;
    if (event.y < offset) return undefined;
    const adjustedEvent: TuiMouseEvent = { ...event, y: event.y - offset, height: Math.max(0, event.height - offset - 1) };
    const result = this.settingsList.handleMouse?.(adjustedEvent);
    if (result) {
      const direction = event.type === "wheel" && (event.wheelDelta ?? 0) < 0 ? "up" : "down";
      this.skipUnselectableItems(direction);
      this.tui.requestRender();
      return result;
    }
    return undefined;
  }

  private maxVisibleRows(): number {
    return 10;
  }

  private resetScrollForDetails(identity: string): void {
    if (identity !== this.bodyIdentity) {
      this.bodyIdentity = identity;
      this.frame.resetScroll();
    }
  }

  private isScoutCurrentlyEnabled(): boolean {
    const scoutItem = this.items?.find((i) => i.id === "scout.enabled");
    if (scoutItem) {
      return scoutItem.currentValue === "enabled";
    }
    return isScoutActive();
  }

  private isSubagentCurrentlyEnabled(): boolean {
    const subItem = this.items?.find((i) => i.id === "subagent.enabled");
    if (subItem) {
      return subItem.currentValue === "enabled";
    }
    return isSubagentActive();
  }

  /**
   * Automatically jumps past unselectable/locked items (such as scout.interceptShell when scout is disabled,
   * or subagent.defaultMode when subagent is disabled).
   */
  private skipUnselectableItems(direction: "down" | "up"): void {
    const anyList = this.settingsList as any;
    const displayItems: SettingItem[] = anyList.getDisplayItems
      ? anyList.getDisplayItems()
      : this.items;

    if (!displayItems || displayItems.length === 0) return;

    const currentItem = displayItems[anyList.selectedIndex];
    const isScoutDormant = currentItem?.id === "scout.interceptShell" && !this.isScoutCurrentlyEnabled();
    const isSubagentDormant = currentItem?.id === "subagent.defaultMode" && !this.isSubagentCurrentlyEnabled();

    if (isScoutDormant || isSubagentDormant) {
      if (direction === "down") {
        anyList.selectedIndex = (anyList.selectedIndex + 1) % displayItems.length;
      } else {
        anyList.selectedIndex =
          (anyList.selectedIndex - 1 + displayItems.length) % displayItems.length;
      }
    }
  }

  private handleSettingChange(id: string, newValue: string): void {
    const key = id as EnhancedSettingKey;

    // Guard: scout.interceptShell cannot be toggled while scout search tools are disabled
    if (key === "scout.interceptShell" && !this.isScoutCurrentlyEnabled()) {
      return;
    }

    // Guard: subagent.defaultMode cannot be toggled while subagents are disabled
    if (key === "subagent.defaultMode" && !this.isSubagentCurrentlyEnabled()) {
      return;
    }

    const enabled = newValue === "enabled";
    if (isToolCacheSetting(key) && TOOL_CACHE_SETTINGS[key].isActive() !== enabled) {
      const tokens = this.getContextTokens();
      if (tokens >= TOOL_CACHE_WARNING_TOKENS) {
        // SettingsList previews the new value before calling us. Keep the old value until confirmed.
        this.settingsList.updateValue(key, enabled ? "disabled" : "enabled");
        this.cacheWarning = { settingKey: key, contextTokens: tokens, enabled, selectedOption: 0 };
        this.tui.requestRender();
        return;
      }
    }

    if (isModelSetting(key)) {
      this.store.set(key, newValue === MODEL_SETTING_SESSION_LABEL ? MODEL_SETTING_SESSION_VALUE : newValue);
      for (const item of this.items) {
        const id = item.id as EnhancedSettingKey;
        if (isThinkingSetting(id) && THINKING_SETTING_MODEL_KEYS[id] === key) {
          Object.assign(item, this.getThinkingItemState(id));
        }
      }
    } else if (isThinkingSetting(key)) {
      const value = newValue === SESSION_THINKING_LABEL ? SESSION_THINKING_VALUE : THINKING_LEVELS.find((level) => level === newValue);
      if (value) this.store.set(key, value);
    } else if (key === "subagent.defaultMode" || key === "usage.contextFormat") {
      this.store.set(key, newValue as any);
    } else {
      this.applyBooleanSetting(key, enabled);
    }
  }

  private getThinkingItemState(key: keyof typeof THINKING_SETTING_MODEL_KEYS) {
    const modelRef = this.store.get(THINKING_SETTING_MODEL_KEYS[key]);
    const { model, levels } = getThinkingLevelOptions(this.availableModels, modelRef === MODEL_SETTING_SESSION_VALUE ? undefined : modelRef);
    const saved = this.store.get(key);
    return {
      currentValue: saved === SESSION_THINKING_VALUE ? SESSION_THINKING_LABEL : formatThinkingOverride(saved, model),
      values: [SESSION_THINKING_LABEL, ...levels],
    };
  }

  private applyBooleanSetting(key: BooleanSettingKey, enabled: boolean): void {
    // A resumed session can have a different active tool state from the saved default.
    this.store.set(key, enabled, {
      notifyIfUnchanged: isToolCacheSetting(key) && TOOL_CACHE_SETTINGS[key].isActive() !== enabled,
    });
    if (key === "scout.enabled") {
      this.syncScoutInterceptorItem(enabled);
    } else if (key === "subagent.enabled") {
      this.syncSubagentModeItem(enabled);
    }
  }

  private syncSubagentModeItem(subagentEnabled: boolean): void {
    const modeItem = this.items.find((i) => i.id === "subagent.defaultMode");
    if (!modeItem) return;

    if (!subagentEnabled) {
      modeItem.description =
        "Default execution mode for isolated subagents (Dormant: requires Subagent Routine to be enabled)";
    } else {
      modeItem.description =
        SETTING_DEFINITIONS["subagent.defaultMode"].description;
    }
    this.settingsList.invalidate();
    this.tui.requestRender();
  }

  private syncScoutInterceptorItem(scoutEnabled: boolean): void {
    const interceptItem = this.items.find((i) => i.id === "scout.interceptShell");
    if (!interceptItem) return;

    if (!scoutEnabled) {
      interceptItem.description =
        "Intercept shell grep/find/rg commands (Dormant: requires Scout Search Tools to be enabled)";
    } else {
      interceptItem.description =
        SETTING_DEFINITIONS["scout.interceptShell"].description;
    }
    this.settingsList.invalidate();
    this.tui.requestRender();
  }

  private getContextTokens(): number {
    if (!this.ctx) return 0;
    try {
      const usage = this.ctx.getContextUsage?.();
      if (typeof usage?.tokens === "number" && usage.tokens > 0) {
        return usage.tokens;
      }
      const branch = this.ctx.sessionManager?.getBranch?.() || [];
      let chars = 0;
      for (const entry of branch) {
        if ((entry as any).content) {
          chars += String((entry as any).content).length;
        }
      }
      return Math.round(chars / 4);
    } catch {
      return 0;
    }
  }
}
