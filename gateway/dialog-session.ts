import type { ExtensionCommandContext, ExtensionUIContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

type DialogComponent = Component & Partial<Focusable> & { dispose?(): void };
type DialogFactory<T> = (
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  done: (result: T) => void
) => DialogComponent | Promise<DialogComponent>;

/** Keep one host mounted while a Discord command visits multiple dialogs. */
export async function withDiscordDialogSession(
  ctx: ExtensionCommandContext,
  run: (ctx: ExtensionCommandContext) => Promise<void>
): Promise<void> {
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") return run(ctx);

  const result = await ctx.ui.custom<{ error: unknown } | undefined>((tui, theme, keybindings, done) => {
    const session = new DiscordDialogSession(tui, theme, keybindings);
    const custom: ExtensionUIContext["custom"] = (factory, options) => options?.overlay
      ? ctx.ui.custom(factory, options)
      : session.show(factory);
    // Host contexts expose read-only getters. Define an own UI property rather
    // than assigning through the inherited getter, and preserve the others.
    const dialogCtx: ExtensionCommandContext = Object.create(ctx, {
      ui: { value: Object.create(ctx.ui, { custom: { value: custom } }) },
    });
    // Let Pi mount the host before running the command, including flows which
    // finish without showing a prompt (e.g. an unconfigured teardown).
    void Promise.resolve().then(() => run(dialogCtx)).then(
      () => done(undefined),
      (error: unknown) => done({ error })
    );
    return session;
  });
  if (result) throw result.error;
}

export class DiscordDialogSession implements Component, Focusable {
  readonly capturesViewportInput = true;
  private component?: DialogComponent;
  private cancelPending?: () => void;
  private acceptingInput = false;
  private hasFocus = false;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager
  ) {}

  get focused(): boolean {
    return this.hasFocus;
  }

  set focused(value: boolean) {
    this.hasFocus = value;
    if (this.component && "focused" in this.component) this.component.focused = value;
  }

  show<T>(factory: DialogFactory<T>): Promise<T> {
    if (this.disposed) return Promise.resolve(undefined as T);
    if (this.cancelPending) return Promise.reject(new Error("A Discord dialog is already open."));
    this.acceptingInput = false;
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (value: T) => {
        if (settled) return;
        settled = true;
        this.acceptingInput = false;
        this.cancelPending = undefined;
        // Keep the previous page visible until its replacement is ready.
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.cancelPending = undefined;
        reject(error);
      };
      this.cancelPending = () => finish(undefined as T);
      try {
        void Promise.resolve(factory(this.tui, this.theme, this.keybindings, finish)).then((component) => {
          if (settled || this.disposed) {
            component.dispose?.();
            return;
          }
          this.releaseComponent();
          this.component = component;
          if ("focused" in component) component.focused = this.hasFocus;
          this.acceptingInput = true;
          this.tui.requestRender();
        }).catch(fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  render(width: number): ReturnType<Component["render"]> {
    // Like native SettingsList submenus, render only the active page at its
    // natural height. Keeping the host mounted must not reserve empty rows.
    return this.component?.render(width) ?? [];
  }

  handleInput(data: string): void {
    if (this.acceptingInput) this.component?.handleInput?.(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.acceptingInput) return this.component?.handleMouse?.(event);
    return undefined;
  }

  invalidate(): void {
    this.component?.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending?.();
    this.acceptingInput = false;
    this.releaseComponent();
  }

  private releaseComponent(): void {
    const component = this.component;
    this.component = undefined;
    if (component && "focused" in component) component.focused = false;
    component?.dispose?.();
  }
}
