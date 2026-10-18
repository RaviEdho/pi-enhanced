import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  SettingsList,
  type Component,
  type SettingItem,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { EnhancedSettingsStore } from "./store.js";
import {
  SETTING_DEFINITIONS,
  type EnhancedSettingKey,
  type SettingDefinition,
} from "./types.js";

interface CacheWarningState {
  contextTokens: number;
  selectedOption: number; // 0 = Keep enabled (recommended), 1 = Proceed and disable
}

/**
 * Interactive settings component for pi-enhanced.
 * Matches Pi's native `/settings` modal conventions:
 * - Clean layout with top and bottom borders
 * - Built-in search input with real-time fuzzy filtering
 * - Native keyboard navigation (Tab, Left/Right cycling, PageUp/PageDown, Home/End, Esc)
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

  constructor(
    tui: TUI,
    theme: any,
    onDone: () => void,
    ctx?: ExtensionCommandContext
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onDone = onDone;
    this.ctx = ctx;
    this.store = EnhancedSettingsStore.getInstance();

    // Build setting items mapped from definitions
    this.items = (
      Object.values(SETTING_DEFINITIONS) as SettingDefinition[]
    ).map((def) => {
      const currentRaw = this.store.get(def.key);
      const currentValue =
        typeof currentRaw === "boolean"
          ? currentRaw
            ? "enabled"
            : "disabled"
          : String(currentRaw);

      return {
        id: def.key,
        label: def.label,
        description: def.description,
        currentValue,
        values: [...def.options],
      };
    });

    const maxVisible = 10; // Exactly matches Pi native settings selector height
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

  public invalidate(): void {
    this.settingsList.invalidate();
  }

  public render(width: number): string[] {
    const lines: string[] = [];

    // Cache warning dialog (if mid-session disable triggered on >= 10k context)
    if (this.cacheWarning) {
      const title = " Prompt Cache Invalidation Warning ";
      const lineWidth = Math.max(0, width - visibleWidth(title) - 2);
      const borderLine = "─".repeat(lineWidth);
      const header =
        this.theme.fg("warning", "──") +
        this.theme.fg("warning", this.theme.bold(title)) +
        this.theme.fg("warning", borderLine);
      lines.push(header);
      lines.push("");

      const kTok = (this.cacheWarning.contextTokens / 1000).toFixed(1);
      lines.push(
        "  " +
          this.theme.fg("warning", "⚠ ") +
          this.theme.fg(
            "text",
            `Active context has ~${kTok}k tokens (≥ 10k threshold).`
          )
      );
      lines.push(
        "  " +
          this.theme.fg(
            "text",
            "Disabling 'ask_user' mid-session removes its tool definition and busts your prefix prompt cache."
          )
      );
      lines.push(
        "  " +
          this.theme.fg(
            "dim",
            "Subsequent requests will incur cache misses, increasing turnaround latency and token costs."
          )
      );
      lines.push("");

      const optKeep =
        this.cacheWarning.selectedOption === 0
          ? this.theme.fg("accent", "→ ") +
            this.theme.fg("accent", this.theme.bold("Keep enabled (recommended)"))
          : "  " + this.theme.fg("dim", "Keep enabled (recommended)");

      const optDisable =
        this.cacheWarning.selectedOption === 1
          ? this.theme.fg("accent", "→ ") +
            this.theme.fg("accent", this.theme.bold("Proceed and disable anyway"))
          : "  " + this.theme.fg("dim", "Proceed and disable anyway");

      lines.push("  " + optKeep);
      lines.push("  " + optDisable);
      lines.push("");
      lines.push("  " + this.theme.fg("dim", "↑/↓ toggle  •  Enter confirm  •  Esc cancel"));
      lines.push(this.theme.fg("warning", "─".repeat(Math.max(1, width))));
      return lines;
    }

    // 1. Top border with title header
    const title = " Enhanced Settings ";
    const lineWidth = Math.max(0, width - visibleWidth(title) - 2);
    const borderLine = "─".repeat(lineWidth);
    const header =
      this.theme.fg("border", "──") +
      this.theme.fg("accent", this.theme.bold(title)) +
      this.theme.fg("border", borderLine);
    lines.push(header);

    // 2. Settings list (contains search input + items + description + native hint line)
    const listLines = this.settingsList.render(width);
    lines.push(...listLines);

    // 3. Bottom border
    const bottomBorder = this.theme.fg("border", "─".repeat(Math.max(1, width)));
    lines.push(bottomBorder);

    return lines;
  }

  public handleInput(data: string): boolean {
    // Intercept input during cache warning confirmation
    if (this.cacheWarning) {
      if (
        matchesKey(data, "escape") ||
        matchesKey(data, "esc") ||
        data === "\x1b" ||
        data === "\x03"
      ) {
        this.settingsList.updateValue("feedback.askUser", "enabled");
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
          this.settingsList.updateValue("feedback.askUser", "enabled");
        } else {
          // Proceed with disabling
          this.store.set("feedback.askUser", false);
        }
        this.cacheWarning = undefined;
        this.tui.requestRender();
        return true;
      }

      return true;
    }

    const anyList = this.settingsList as any;
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
        this.tui.requestRender();
        return true;
      }
    }

    // Shift+Tab: Advance selection up
    if (data === "\x1b[Z") {
      if (displayItems.length > 0) {
        anyList.selectedIndex =
          (anyList.selectedIndex - 1 + displayItems.length) % displayItems.length;
        this.tui.requestRender();
        return true;
      }
    }

    // Left Arrow (\x1b[D): Cycle value backward when not typing inside search query
    if (data === "\x1b[D" && searchVal.length === 0) {
      const currentItem = displayItems[anyList.selectedIndex];
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

    // PageUp (\x1b[5~): Jump selection up by 5
    if (data === "\x1b[5~") {
      anyList.selectedIndex = Math.max(0, anyList.selectedIndex - 5);
      this.tui.requestRender();
      return true;
    }

    // PageDown (\x1b[6~): Jump selection down by 5
    if (data === "\x1b[6~") {
      anyList.selectedIndex = Math.min(
        displayItems.length - 1,
        anyList.selectedIndex + 5
      );
      this.tui.requestRender();
      return true;
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
    this.settingsList.handleInput?.(data);
    this.tui.requestRender();
    return true;
  }

  public handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Top border occupies row 0; adjust y by -1 for SettingsList
    if (event.y >= 1) {
      const adjustedEvent: TuiMouseEvent = {
        ...event,
        y: event.y - 1,
      };
      const result = this.settingsList.handleMouse?.(adjustedEvent);
      if (result) {
        this.tui.requestRender();
        return result;
      }
    }

    return undefined;
  }

  private handleSettingChange(id: string, newValue: string): void {
    const key = id as EnhancedSettingKey;

    // Check mid-run prompt cache invalidation warning for ask_user
    if (key === "feedback.askUser" && newValue === "disabled") {
      const tokens = this.getContextTokens();
      if (tokens >= 10_000) {
        this.cacheWarning = {
          contextTokens: tokens,
          selectedOption: 0,
        };
        this.tui.requestRender();
        return;
      }
    }

    if (key === "subagent.defaultMode" || key === "usage.contextFormat") {
      this.store.set(key, newValue as any);
    } else {
      this.store.set(key, (newValue === "enabled") as any);
    }
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
