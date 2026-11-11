import { ExtensionInputComponent, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

/** Pi's own extension input, including native focus/IME handling and chrome. */
export class DiscordInputDialog extends ExtensionInputComponent {
  constructor(
    tui: TUI,
    _theme: Theme,
    title: string,
    instruction: string,
    initialValue: string,
    placeholder: string,
    private readonly done: (value: string | undefined) => void,
    private readonly keybindings?: KeybindingsManager
  ) {
    super(title, placeholder, done, () => done(undefined), {
      tui,
      initialValue,
      // Native input does not display its placeholder argument. Keep the
      // existing default/current-value guidance visible in the description.
      description: [instruction, ...(!initialValue && placeholder ? [placeholder] : [])].join("\n"),
    });
  }

  handleInput(data: string): void {
    if (data === "\x03" || this.keybindings?.matches(data, "app.interrupt")) this.done(undefined);
    else super.handleInput(data);
  }
}
