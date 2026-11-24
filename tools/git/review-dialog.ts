import { stripVTControlCharacters } from "node:util";
import { keyHint, rawKeyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DialogFrame, renderDialogActions } from "../../ux/dialog.js";

type ReviewContext = Pick<ExtensionCommandContext, "ui" | "mode">;

function reviewDialog(
  ctx: ReviewContext,
  title: string,
  body: string[],
  actions: string[],
  permission = false,
): Promise<string | undefined> {
  const content = stripVTControlCharacters(body.join("\n"))
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\p{Cc}/gu, char => char === "\n" ? char : char === "\t" ? "    " : " ")
    .split("\n").map(line => line ? `  ${line}` : "");
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const frame = new DialogFrame(tui, theme);
    let selected = permission ? 1 : 0;
    return {
      capturesViewportInput: true,
      invalidate() {},
      handleInput(data: string) {
        if (frame.handleInput(data)) return true;
        if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.interrupt") || data === "\x03") {
          done(undefined);
          return true;
        }
        if (keys.matches(data, "tui.select.confirm")) {
          done(actions[selected]);
          return true;
        }
        const up = keys.matches(data, "tui.select.up") || data === "k";
        if (up || keys.matches(data, "tui.select.down") || matchesKey(data, "tab") || data === "j") {
          selected = Math.max(0, Math.min(actions.length - 1, selected + (up ? -1 : 1)));
          tui.requestRender();
          return true;
        }
        return false;
      },
      handleMouse(event) {
        const scrolled = frame.handleMouse(event);
        if (scrolled) return scrolled;
        const row = frame.actionRowAt(event.y);
        if (row === undefined || event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
        selected = row;
        if (event.type === "click") done(actions[selected]);
        return { handled: true, render: true };
      },
      render(width: number) {
        return frame.render(width, {
          title,
          content,
          actions: renderDialogActions(actions, selected, width),
          actionFocusLine: selected,
          hints: [rawKeyHint("↑/↓", "select action"), keyHint("tui.select.confirm", "confirm"), keyHint("tui.select.cancel", "close")],
        });
      },
    };
  }, { blocked: { kind: permission ? "permission" : "question", message: title } });
}

/** Long reviews scroll in Pi's TUI; RPC clients keep their native prompts. */
export function selectGitReview(ctx: ReviewContext, title: string, body: string[], actions: string[]): Promise<string | undefined> {
  if (ctx.mode === "tui") return reviewDialog(ctx, title, body, actions);
  return ctx.ui.select([title, ...body].join("\n"), actions);
}

export async function confirmGitReview(ctx: ReviewContext, title: string, body: string[], confirmLabel = "Yes"): Promise<boolean> {
  if (ctx.mode !== "tui") return ctx.ui.confirm(title, body.join("\n"));
  return await reviewDialog(ctx, title, body, [confirmLabel, "No"], true) === confirmLabel;
}
