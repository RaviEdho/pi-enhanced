import {
  DynamicBorder, getSettingsListTheme, type ExtensionCommandContext, type KeybindingsManager, type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container, SettingsList, Spacer, Text, type Component, type Focusable, type Input, type SettingItem,
  type TUI, type TuiMouseEvent, type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { currentChoiceLabel } from "./select-dialog.js";

interface SettingRow {
  id: string;
  label: string;
  description: string;
  currentValue: string;
}

export type DiscordSettingRow = SettingRow & (
  | { kind: "inline"; values: string[]; change: (value: string) => void }
  | { kind: "group" | "picker" | "input" | "action"; open: () => void | Promise<void> }
);

interface PageOptions {
  title: string;
  description?: string;
  searchable?: boolean;
  gatewayLabel?: string;
}

/** Keep the native list instance (selection, scroll position, and search) across child dialogs. */
export async function runGatewaySettingsPage(
  ctx: ExtensionCommandContext,
  options: PageOptions,
  getRows: () => DiscordSettingRow[] | undefined,
): Promise<void> {
  let page: DiscordSettingsPage | undefined;
  let canUseCustom = ctx.mode === "tui" && typeof ctx.ui.custom === "function";
  let lastId: string | undefined;
  const reportError = (row: DiscordSettingRow, error: unknown) => {
    ctx.ui.notify(`${options.gatewayLabel ?? "Discord gateway"} · ${row.label}: ${error instanceof Error ? error.message : String(error)}`, "error");
  };
  const change = (row: Extract<DiscordSettingRow, { kind: "inline" }>, value: string) => {
    try { row.change(value); } catch (error) { reportError(row, error); }
  };

  while (true) {
    let rows = getRows();
    if (!rows) return;
    let row: DiscordSettingRow | undefined;
    if (canUseCustom) {
      const initialRows = rows;
      try {
        row = await ctx.ui.custom<DiscordSettingRow | undefined>((tui, theme, keybindings, done) => {
          page ??= new DiscordSettingsPage(tui, theme, keybindings, options);
          const activePage = page;
          activePage.attach(initialRows, lastId, (id, value) => {
            const selected = rows?.find((entry) => entry.id === id);
            if (selected?.kind !== "inline") {
              done(selected);
              return;
            }
            change(selected, value);
            try {
              rows = getRows();
              if (rows) activePage.updateRows(rows, id);
              else done(undefined);
            } catch (error) {
              reportError(selected, error);
              done(undefined);
            }
          }, () => done(undefined));
          return activePage;
        });
      } catch {
        canUseCustom = false;
        continue;
      }
    } else {
      // Non-TUI hosts have a plain selector, not a SettingsList with inline editing.
      const labels = rows.map((entry) => `${entry.label} — ${entry.currentValue}`);
      const title = [options.title, options.description].filter(Boolean).join("\n");
      const selected = await ctx.ui.select(title, labels);
      row = selected === undefined ? undefined : rows[labels.indexOf(selected)];
      if (row?.kind === "inline") {
        const { currentValue, values } = row;
        const choices = values.map((value) => currentChoiceLabel(value, value === currentValue));
        const selectedValue = await ctx.ui.select(`${row.label}\n${row.description}`, choices);
        const value = selectedValue === undefined ? undefined : values[choices.indexOf(selectedValue)];
        if (value !== undefined && value !== currentValue) change(row, value);
        continue;
      }
    }
    if (!row || row.kind === "inline") return;
    lastId = row.id;
    try { await row.open(); } catch (error) { reportError(row, error); }
  }
}

class DiscordSettingsPage implements Component, Focusable {
  readonly capturesViewportInput = true;
  private container = new Container();
  private list?: SettingsList;
  private items: SettingItem[] = [];
  private onChange?: (id: string, value: string) => void;
  private onCancel?: () => void;
  private hasFocus = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly options: PageOptions,
  ) {}

  // SettingsList owns the search input but does not expose focus or the query.
  private get searchInput(): Input | undefined {
    return (this.list as unknown as { searchInput?: Input } | undefined)?.searchInput;
  }

  get focused(): boolean { return this.hasFocus; }
  set focused(value: boolean) {
    this.hasFocus = value;
    const search = this.searchInput;
    if (search) search.focused = value;
  }

  attach(
    rows: DiscordSettingRow[], lastId: string | undefined,
    onChange: (id: string, value: string) => void, onCancel: () => void,
  ): void {
    this.onChange = onChange;
    this.onCancel = onCancel;
    this.updateRows(rows, lastId);
  }

  updateRows(rows: DiscordSettingRow[], lastId: string | undefined): void {
    const items = rows.map(({ id, label, description, currentValue, ...row }): SettingItem => ({
      id, label, description, currentValue,
      // Like vanilla's Apply row, actions use a single value as an activation target.
      values: row.kind === "inline" ? row.values : [currentValue],
    }));
    if (this.list && items.length === this.items.length && items.every(({ id }, index) => id === this.items[index]?.id)) {
      // Keep item identity: SettingsList's filtered view references the same objects.
      items.forEach((item, index) => Object.assign(this.items[index]!, item));
      return;
    }
    // Auto mode adds/removes routing settings; reapply the query to the new list.
    const query = this.searchInput?.getValue();
    this.items = items;
    this.list = new SettingsList(items, Math.min(items.length, 10), getSettingsListTheme(),
      (id, value) => this.onChange?.(id, value), () => this.onCancel?.(),
      { enableSearch: this.options.searchable });
    if (query) this.list.handleInput(`\x1b[200~${query}\x1b[201~`);
    if (lastId) this.list.selectItem(lastId);
    this.focused = this.hasFocus;
    this.container = new Container();
    this.container.addChild(new DynamicBorder((line) => this.theme.fg("border", line)));
    this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", this.options.title)), 0, 0));
    if (this.options.description) {
      this.container.addChild(new Spacer(1));
      this.container.addChild(new Text(this.theme.fg("muted", this.options.description), 0, 0));
    }
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.list);
    this.container.addChild(new DynamicBorder((line) => this.theme.fg("border", line)));
  }

  invalidate(): void { this.container.invalidate(); }
  render(width: number): string[] { return this.container.render(width); }
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined { return this.container.handleMouse(event); }
  handleInput(data: string): void {
    if (data === "\x03" || this.keybindings.matches(data, "app.interrupt")) this.onCancel?.();
    else this.list?.handleInput(data);
    this.tui.requestRender();
  }
}
