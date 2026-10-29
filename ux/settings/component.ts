import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  stripTerminalSequences,
  fuzzyFilter,
  getKeybindings,
  Input,
  SelectList,
  SettingsList,
  wrapTextWithAnsi,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { isFeedbackToolActive } from "../../tools/feedback/index.js";
import { isScoutActive } from "../../tools/scout/index.js";
import { isSubagentActive } from "../../tools/subagent/index.js";
import { isWebActive } from "../../tools/web/index.js";
import { DialogFrame } from "../dialog.js";
import { EnhancedSettingsStore } from "./store.js";
import {
  COMMIT_MODEL_SESSION_LABEL,
  COMMIT_MODEL_SESSION_VALUE,
  SETTING_DEFINITIONS,
  type EnhancedSettingKey,
  type SettingDefinition,
} from "./types.js";

interface CacheWarningState {
  settingKey: "feedback.askUser" | "scout.enabled" | "subagent.enabled" | "web.enabled";
  toolLabel: string;
  contextTokens: number;
  selectedOption: number; // 0 = Keep enabled (recommended), 1 = Proceed and disable
}

/**
 * Interactive settings component for pi-enhanced.
 * Matches Pi's native `/settings` modal conventions:
 * - Shared, bounded dialog chrome and page scrolling
 * - Built-in search input with real-time fuzzy filtering
 * - Native keyboard navigation (Tab, Left/Right cycling, Home/End, Esc)
 */
export class EnhancedSettingsComponent implements Component {
  private tui: TUI;
  private theme: any;
  private onDone: () => void;
  private ctx?: ExtensionCommandContext;
  private store: EnhancedSettingsStore;
  private settingsList: SettingsList;
  private items: SettingItem[];
  private cacheWarning?: CacheWarningState;
  private frame: DialogFrame;
  private focusSearch = true;
  private hasFocus = false;
  private modelMenu?: { title: string; searchInput: Input; focusLine: number; details: string[]; detailKey: string };
  private bodyIdentity?: string;

  constructor(
    tui: TUI,
    theme: any,
    onDone: () => void,
    ctx?: ExtensionCommandContext
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
    const configuredCommitModel = this.store.get("git.commitModel");
    const configuredTitleModel = this.store.get("session.titleModel");
    const modelChoices: SelectItem[] = [
      {
        value: COMMIT_MODEL_SESSION_LABEL,
        label: COMMIT_MODEL_SESSION_LABEL,
        description: "Follow the model currently selected in the Pi session",
      },
    ];
    try {
      const availableModels = this.ctx?.modelRegistry.getAvailable() ?? [];
      modelChoices.push(...availableModels
        .map((model) => ({
          value: `${model.provider}/${model.id}`,
          label: `${model.provider}/${model.id}`,
          description: model.name,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)));
    } catch {
      // Keep the session-model option available if the registry cannot be read.
    }
    for (const configuredModel of [configuredCommitModel, configuredTitleModel]) {
      if (
        configuredModel !== COMMIT_MODEL_SESSION_VALUE &&
        !modelChoices.some((choice) => choice.value === configuredModel)
      ) {
        modelChoices.push({
          value: configuredModel,
          label: `${configuredModel} (unavailable)`,
          description: "This saved model is not currently available",
        });
      }
    }

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

      if (def.key === "git.commitModel" || def.key === "session.titleModel") {
        const isTitleModel = def.key === "session.titleModel";
        options = [];
        const selectedValue = String(currentRaw) === COMMIT_MODEL_SESSION_VALUE
          ? COMMIT_MODEL_SESSION_LABEL
          : String(currentRaw);
        const selectedChoice = modelChoices.find((choice) => choice.value === selectedValue);
        currentValue = selectedChoice?.label ?? selectedValue;
        submenu = (_value, done) => {
          const listTheme = {
            selectedPrefix: (text: string) => this.theme.fg("accent", text),
            selectedText: (text: string) => this.theme.fg("accent", text),
            description: (text: string) => this.theme.fg("muted", text),
            scrollInfo: (text: string) => this.theme.fg("dim", text),
            noMatch: (text: string) => this.theme.fg("warning", text),
          };
          const searchInput = new Input({
            placeholder: "Search models...",
            placeholderStyle: (text) => this.theme.fg("dim", text),
          });
          let selectList: SelectList;
          let focusSearch = false;
          let listRows = 0;
          const menu = {
            title: isTitleModel ? "Select Title Generation Model" : "Select Git Commit Model",
            searchInput,
            focusLine: 0,
            details: [] as string[],
            detailKey: "",
          };
          this.modelMenu = menu;
          this.frame.resetScroll();

          const finish = (value?: string) => {
            this.modelMenu = undefined;
            this.focusSearch = false;
            this.frame.resetScroll();
            done(value);
          };
          const createSelectList = (query: string) => {
            const choices = query
              ? fuzzyFilter(modelChoices, query, (choice) => `${choice.value} ${choice.description ?? ""}`)
              : modelChoices;
            selectList = new SelectList(choices, this.maxVisibleRows(), listTheme);
            const selectedIndex = query
              ? -1
              : choices.findIndex((choice) => choice.value === selectedValue);
            if (selectedIndex >= 0) selectList.setSelectedIndex(selectedIndex);
            selectList.onSelect = (choice) => finish(choice.value);
            selectList.onCancel = () => finish();
          };
          createSelectList("");

          return {
            render: (width: number) => {
              searchInput.focused = this.hasFocus;
              const selected = selectList.getSelectedItem();
              // Keep native search/list rows pinned; full model details scroll above them.
              const details = selected
                ? [selected.label ?? selected.value, selected.description ?? ""]
                    .filter(Boolean)
                    .flatMap((text) => wrapTextWithAnsi(text, Math.max(1, width - 2)))
                : [];
              menu.details = details.map((line) => this.theme.fg("muted", `  ${line}`));
              menu.detailKey = JSON.stringify([selected?.value, selected?.label, selected?.description]);
              (selectList as any).maxVisible = this.maxVisibleRows();
              const rows = selectList.render(width);
              listRows = rows.length;
              const selectedRow = rows.findIndex((line) => stripTerminalSequences(line).startsWith("→ "));
              menu.focusLine = focusSearch ? 0 : 2 + Math.max(0, selectedRow);
              return [
                ...searchInput.render(width), "", ...rows,
              ];
            },
            invalidate: () => {
              searchInput.invalidate();
              selectList.invalidate();
            },
            handleInput: (data: string) => {
              const keybindings = getKeybindings();
              if (
                keybindings.matches(data, "tui.select.up") ||
                keybindings.matches(data, "tui.select.down") ||
                keybindings.matches(data, "tui.select.confirm") ||
                keybindings.matches(data, "tui.select.cancel")
              ) {
                focusSearch = false;
                selectList.handleInput(data);
              } else {
                focusSearch = true;
                const previousQuery = searchInput.getValue();
                searchInput.handleInput(data);
                if (searchInput.getValue() !== previousQuery) createSelectList(searchInput.getValue());
              }
              this.tui.requestRender();
            },
            handleMouse: (event: TuiMouseEvent) => {
              if (event.y === 0) {
                focusSearch = true;
                return searchInput.handleMouse(event);
              }
              if (event.y >= 2 && event.y < 2 + listRows) {
                focusSearch = false;
                return selectList.handleMouse({ ...event, y: event.y - 2 });
              }
              return undefined;
            },
          };
        };
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
    if (this.modelMenu) this.modelMenu.searchInput.focused = value;
  }

  public invalidate(): void {
    this.settingsList.invalidate();
    (this.settingsList as any).searchInput?.invalidate();
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
      paragraph(`Active context has ~${(warning.contextTokens / 1000).toFixed(1)}k tokens (≥ 10k threshold).`, "warning");
      content.push("");
      paragraph(`Disabling ${warning.toolLabel} mid-session removes tool definitions and busts your prefix prompt cache.`, "text");
      content.push("");
      paragraph("Subsequent requests will incur cache misses, increasing turnaround latency and token costs.", "dim");
      const actions: string[] = [];
      let actionFocusLine = 0;
      ["Keep enabled (recommended)", "Proceed and disable anyway"].forEach((label, index) => {
        const selected = index === warning.selectedOption;
        if (selected) actionFocusLine = actions.length;
        const prefix = selected ? "→ " : "  ";
        const rows = wrapTextWithAnsi(selected ? this.theme.bold(label) : label, Math.max(1, innerWidth - 2));
        actions.push(...rows.map((line, row) =>
          `  ${this.theme.fg(selected ? "accent" : "dim", `${row === 0 ? prefix : "  "}${line}`)}`));
      });
      this.resetScrollForDetails(`warning:${warning.settingKey}`);
      return this.frame.render(width, {
        title: "Prompt Cache Invalidation Warning",
        content,
        actions,
        actionFocusLine,
        hints: ["↑↓ toggle", "Enter confirm", "Esc cancel"],
      });
    }

    const anyList = this.settingsList as any;
    const submenu = !!anyList.submenuComponent;
    const displayItems: SettingItem[] = anyList.getDisplayItems();
    const selected = displayItems[anyList.selectedIndex];
    if (!submenu) {
      anyList.maxVisible = this.maxVisibleRows();
      anyList.searchInput.focused = this.hasFocus;
    }
    let listLines = this.settingsList.render(innerWidth);
    let content: string[] = this.modelMenu?.details ?? [];
    if (!submenu) {
      // Native SettingsList ends with a blank and its own keyboard hint.
      // The frame owns hints, including scroll instructions and dismissal.
      listLines = listLines.slice(0, -2);
      // Native SettingsList puts a blank description separator after the search,
      // visible item rows, and optional count. Retain their original row offsets
      // for mouse dispatch, but move everything after that separator into the body.
      const descriptionStart = listLines.indexOf("", 2);
      content = descriptionStart < 0 ? [] : listLines.slice(descriptionStart + 1);
      if (descriptionStart >= 0) listLines = listLines.slice(0, descriptionStart);
      if (selected?.submenu && selected.currentValue) {
        content.push("", ...wrapTextWithAnsi(selected.currentValue, Math.max(1, innerWidth - 2))
          .map((line) => this.theme.fg("muted", `  ${line}`)));
      }

      listLines = listLines.map((line) => {
        const clean = stripTerminalSequences(line);
        if ((!this.isScoutCurrentlyEnabled() && clean.includes("Scout Shell Interceptor")) ||
            (!this.isSubagentCurrentlyEnabled() && clean.includes("Subagent Default Mode"))) {
          return this.theme.fg("dim", clean);
        }
        return line;
      });
    }
    this.resetScrollForDetails(this.modelMenu
      ? `model:${this.modelMenu.detailKey}`
      : JSON.stringify([selected?.id, selected?.description, selected?.submenu ? selected.currentValue : undefined]));
    const selectedRow = listLines.findIndex((line) => stripTerminalSequences(line).startsWith("→ "));
    return this.frame.render(width, {
      title: this.modelMenu?.title ?? "Enhanced Settings",
      metadata: this.modelMenu ? "Enhanced Settings" : undefined,
      content: content.map((line) => `  ${line}`),
      actions: listLines.map((line) => `  ${line}`),
      hints: this.modelMenu
        ? ["Type to search", "↑↓ navigate", "Enter select", "Esc back"]
        : ["Type to search", "↑↓/Tab navigate", "←→/Enter change", "Esc close"],
      actionFocusLine: this.modelMenu?.focusLine ?? (this.focusSearch ? 0 : Math.max(0, selectedRow)),
    });
  }

  public handleInput(data: string): boolean {
    if (this.frame.handleInput(data)) return true;
    // Intercept input during cache warning confirmation
    if (this.cacheWarning) {
      if (
        matchesKey(data, "escape") ||
        matchesKey(data, "esc") ||
        data === "\x1b" ||
        data === "\x03"
      ) {
        this.settingsList.updateValue(this.cacheWarning.settingKey, "enabled");
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
        if (this.cacheWarning.selectedOption === 0) {
          // Revert to enabled
          this.settingsList.updateValue(this.cacheWarning.settingKey, "enabled");
        } else {
          // Proceed with disabling
          this.store.set(this.cacheWarning.settingKey, false);
          if (this.cacheWarning.settingKey === "scout.enabled") {
            this.syncScoutInterceptorItem(false);
          } else if (this.cacheWarning.settingKey === "subagent.enabled") {
            this.syncSubagentModeItem(false);
          }
        }
        this.cacheWarning = undefined;
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
    const keybindings = getKeybindings();
    this.focusSearch = !(
      keybindings.matches(data, "tui.select.up") ||
      keybindings.matches(data, "tui.select.down") ||
      keybindings.matches(data, "tui.select.confirm") ||
      data === "\t" || data === "\x1b[Z" ||
      (searchVal.length === 0 && (
        matchesKey(data, "left") || matchesKey(data, "right") ||
        matchesKey(data, "home") || matchesKey(data, "end") || data === " "
      ))
    );

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
    // Descriptions and warning dialogs scroll without touching the pinned controls.
    // Preserve native list mouse navigation when the pointer is over that list.
    const actionRow = this.frame.actionRowAt(event.y);
    if (this.cacheWarning || actionRow === undefined || event.x < 2) {
      return this.frame.handleMouse(event);
    }
    const adjustedEvent: TuiMouseEvent = {
      ...event,
      x: event.x - 2,
      y: actionRow,
    };
    this.focusSearch = adjustedEvent.y === 0 && event.type !== "wheel";
    const result = this.settingsList.handleMouse?.(adjustedEvent);
    if (result) {
      const direction = event.type === "wheel" && (event.wheelDelta ?? 0) < 0 ? "up" : "down";
      this.skipUnselectableItems(direction);
      this.tui.requestRender();
      return result;
    }
    return this.frame.handleMouse(event);
  }

  private maxVisibleRows(): number {
    // Budget from total height, never bodyHeight (which excludes pinned actions).
    // Reserve chrome/hints (8), search/gap/count (3), and three detail rows.
    return Math.max(1, Math.min(10, this.frame.maxHeight - 14));
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

    // Check mid-run prompt cache invalidation warning for ask_user, scout tools, subagent tools, or web tools
    if (
      (key === "feedback.askUser" ||
        key === "scout.enabled" ||
        key === "subagent.enabled" ||
        key === "web.enabled") &&
      newValue === "disabled"
    ) {
      const tokens = this.getContextTokens();
      if (tokens >= 10_000) {
        let toolLabel: string;
        if (key === "feedback.askUser") {
          toolLabel = "Ask User Tools ('ask_user')";
        } else if (key === "scout.enabled") {
          toolLabel = "Scout Search Tools ('find', 'grep')";
        } else if (key === "web.enabled") {
          toolLabel = "Web Access Tools ('web_search', 'web_fetch')";
        } else {
          toolLabel = "Subagent Tools ('subagent', 'subagent_status', 'subagent_list', 'subagent_cancel')";
        }

        this.cacheWarning = {
          settingKey: key,
          toolLabel,
          contextTokens: tokens,
          selectedOption: 0,
        };
        this.tui.requestRender();
        return;
      }
    }

    if (key === "git.commitModel" || key === "session.titleModel") {
      this.store.set(
        key,
        (newValue === COMMIT_MODEL_SESSION_LABEL ? COMMIT_MODEL_SESSION_VALUE : newValue) as any
      );
    } else if (key === "subagent.defaultMode" || key === "usage.contextFormat") {
      this.store.set(key, newValue as any);
    } else {
      const enabled = newValue === "enabled";
      this.store.set(key, enabled as any);

      if (key === "scout.enabled") {
        this.syncScoutInterceptorItem(enabled);
      } else if (key === "subagent.enabled") {
        this.syncSubagentModeItem(enabled);
      }
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
