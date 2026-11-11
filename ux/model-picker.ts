import { DynamicBorder, getSelectListTheme, keyHint, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyFilter, Input, SelectList, Spacer, Text, type Component, type Focusable, type SelectItem, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";

export interface ModelPickerOptions {
  title: string;
  description?: string;
  choices: SelectItem[];
  currentValue: string;
  refresh?: Promise<void>;
  bordered?: boolean;
}

/** Searchable native submenu shared by Discord and enhanced settings. */
export class ModelPickerComponent implements Component, Focusable {
  readonly capturesViewportInput = true;
  private readonly input: Input;
  private list!: SelectList;
  private container = new Container();
  private refreshing: boolean;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: Pick<KeybindingsManager, "matches">,
    private readonly options: ModelPickerOptions,
    private readonly done: (value: string | undefined) => void
  ) {
    this.input = new Input({ placeholder: "Search models…", placeholderStyle: (text) => theme.fg("dim", text) });
    this.refreshing = !!options.refresh;
    if (options.refresh) void options.refresh.then(() => this.finishRefresh(), () => this.finishRefresh());
    this.updateList();
  }

  get focused(): boolean { return this.input.focused; }
  set focused(value: boolean) { this.input.focused = value; }

  private finishRefresh(): void {
    this.refreshing = false;
    if (!this.disposed) this.tui.requestRender();
  }

  private updateList(): void {
    const query = this.input.getValue();
    const choices = query
      ? fuzzyFilter(this.options.choices, query, (item) => `${item.label} ${item.value} ${item.description ?? ""}`)
      : this.options.choices;
    this.list = new SelectList(choices, Math.min(10, Math.max(1, choices.length)), getSelectListTheme(), {
      minPrimaryColumnWidth: 12,
      maxPrimaryColumnWidth: 46,
    });
    const index = choices.findIndex((choice) => choice.value === this.options.currentValue);
    if (!query && index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = (item) => this.done(item.value);
    this.list.onCancel = () => this.done(undefined);
  }

  handleInput(data: string): void {
    const navigation = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "tui.select.confirm", "tui.select.cancel"] as const;
    if (data === "\x03") this.done(undefined);
    else if (navigation.some((action) => this.keybindings.matches(data, action))) this.list.handleInput(data);
    else {
      const previous = this.input.getValue();
      this.input.handleInput(data);
      if (previous !== this.input.getValue()) this.updateList();
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    this.container = new Container();
    if (this.options.bordered !== false) this.container.addChild(new DynamicBorder());
    this.container.addChild(new Text(this.theme.bold(this.theme.fg("accent", this.options.title)), 0, 0));
    if (this.options.description) this.container.addChild(new Text(this.theme.fg("muted", this.options.description), 0, 0));
    if (this.refreshing) this.container.addChild(new Text(this.theme.fg("dim", "Refreshing model catalogs…"), 0, 0));
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.input);
    this.container.addChild(new Spacer(1));
    this.container.addChild(this.list);
    this.container.addChild(new Spacer(1));
    this.container.addChild(new Text(this.theme.fg("dim", ["Type to search", keyHint("tui.select.confirm", "select"), keyHint("tui.select.cancel", "back")].join(" · ")), 0, 0));
    if (this.options.bordered !== false) this.container.addChild(new DynamicBorder());
    return this.container.render(width);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.container.handleMouse(event);
  }

  invalidate(): void { this.container.invalidate(); }
  dispose(): void { this.disposed = true; }
}
