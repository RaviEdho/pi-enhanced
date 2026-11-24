import { stripVTControlCharacters } from "node:util";
import { keyHint, rawKeyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DialogFrame, renderDialogActions } from "../../ux/dialog.js";

type ReviewContext = Pick<ExtensionCommandContext, "ui" | "mode">;
type ReviewTheme = ExtensionCommandContext["ui"]["theme"];
type SummaryRows = ReadonlyArray<readonly [label: string, value: string]>;
export type GitMenuAction = readonly [label: string, command: string, disabledReason?: string];

function cleanLine(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]/gu, "");
}

function textBody(body: string[]): string[] {
  return stripVTControlCharacters(body.join("\n"))
    .replace(/\p{Bidi_Control}/gu, "")
    .replace(/\p{Cc}/gu, char => char === "\n" ? char : char === "\t" ? "    " : " ")
    .split("\n").map(line => line ? `  ${line}` : "");
}

function reviewDialog(
  ctx: ReviewContext,
  title: string,
  renderContent: (theme: ReviewTheme) => string[],
  actions: readonly string[],
  { permission = false, preferFullBody = false, disabled = [] as readonly (string | undefined)[] } = {},
): Promise<number | undefined> {
  const labels = actions.map(cleanLine);
  const enabled = actions.flatMap((_, index) => disabled[index] === undefined ? [index] : []);
  return ctx.ui.custom<number | undefined>((tui, theme, keys, done) => {
    const frame = new DialogFrame(tui, theme);
    let selected = permission ? 1 : (enabled[0] ?? -1);
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
          if (selected >= 0 && frame.refocusScrolledAction(selected)) tui.requestRender();
          else if (selected >= 0) done(selected);
          else if (!actions.length) done(undefined);
          return true;
        }
        const up = keys.matches(data, "tui.select.up") || data === "k";
        if (up || keys.matches(data, "tui.select.down") || matchesKey(data, "tab") || data === "j") {
          if (enabled.length) {
            const index = enabled.indexOf(selected);
            selected = enabled[Math.max(0, Math.min(enabled.length - 1, index + (up ? -1 : 1)))];
            frame.followActions();
            tui.requestRender();
          } else {
            frame.scrollBy(up ? -1 : 1);
          }
          return true;
        }
        return false;
      },
      handleMouse(event) {
        const row = frame.actionRowAt(event.y);
        if (disabled.length && row !== undefined && event.type === "wheel" && event.wheelDelta) {
          frame.scrollActionsBy(event.wheelDelta);
          return { handled: true, render: true };
        }
        const scrolled = frame.handleMouse(event);
        if (scrolled) return scrolled;
        if (row === undefined || event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
        if (disabled[row] !== undefined) return { handled: true };
        selected = row;
        frame.followActions();
        if (event.type === "click") done(selected);
        return { handled: true, render: true };
      },
      render(width: number) {
        return frame.render(width, {
          title,
          content: renderContent(theme),
          preferFullBody,
          actions: actions.length ? renderDialogActions(labels, selected, width).map((line, index) => {
            const reason = disabled[index];
            if (reason === undefined) return line;
            return `    ${theme.fg("dim", `${labels[index]} · ${cleanLine(reason)}`)}`;
          }) : undefined,
          actionFocusLine: selected >= 0 ? selected : undefined,
          hints: enabled.length
            ? [rawKeyHint("↑/↓", "select action"), keyHint("tui.select.confirm", permission ? "confirm" : "select"), keyHint("tui.select.cancel", "close")]
            : [rawKeyHint("↑/↓", "scroll"), keyHint("tui.select.cancel", "close")],
        });
      },
    };
  }, { blocked: { kind: permission ? "permission" : "question", message: title } });
}

/** Long reviews scroll in Pi's TUI; RPC clients keep their native prompts. */
export async function selectGitReview(ctx: ReviewContext, title: string, body: string[], actions: string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.select([title, ...body].join("\n"), actions);
  const content = textBody(body);
  const index = await reviewDialog(ctx, title, () => content, actions);
  return index === undefined ? undefined : actions[index];
}

export async function confirmGitReview(ctx: ReviewContext, title: string, body: string[], confirmLabel = "Yes"): Promise<boolean> {
  if (ctx.mode !== "tui") return ctx.ui.confirm(title, body.join("\n"));
  const content = textBody(body);
  return await reviewDialog(ctx, title, () => content, [confirmLabel, "No"], { permission: true }) === 0;
}

async function selectSummaryAction(
  ctx: ReviewContext, title: string, rows: SummaryRows, labels: string[], rpcTitle?: string,
  disabled?: readonly (string | undefined)[],
): Promise<number | undefined> {
  if (!labels.length) return undefined;
  const summary = rows.map(([label, value]) => [label, cleanLine(value)] as const);
  if (ctx.mode === "tui") {
    const column = Math.max(8, ...summary.map(([label]) => label.length)) + 2;
    return reviewDialog(ctx, title, theme => summary.map(([label, value]) =>
      `  ${theme.fg("muted", label.padEnd(column))}${value}`), labels, { preferFullBody: true, disabled });
  }
  const enabled = labels.flatMap((label, index) => disabled?.[index] === undefined ? [{ label, index }] : []);
  const unavailable = labels.flatMap((label, index) => {
    const reason = disabled?.[index];
    return reason === undefined ? [] : [`Unavailable: ${label} — ${cleanLine(reason)}`];
  });
  const heading = rpcTitle ?? [title, ...summary.map(([label, value]) => `${label}: ${value}`), ...unavailable].join("\n");
  if (!enabled.length) {
    ctx.ui.notify(heading, "info");
    return undefined;
  }
  const selected = await ctx.ui.select(heading, enabled.map(({ label }) => label));
  return enabled.find(({ label }) => label === selected)?.index;
}

export async function selectGitPicker(
  ctx: ReviewContext, title: string, rows: SummaryRows, choices: string[], rpcTitle?: string,
): Promise<string | undefined> {
  const index = await selectSummaryAction(ctx, title, rows, choices, rpcTitle);
  return index === undefined ? undefined : choices[index];
}

export async function selectGitMenu(
  ctx: ReviewContext, title: string, rows: SummaryRows, actions: readonly GitMenuAction[],
): Promise<string | undefined> {
  const labels = actions.map(([label, command, reason]) => ctx.mode === "tui" || reason !== undefined ? label : `${label} (${command})`);
  const disabled = actions.some(([, , reason]) => reason !== undefined) ? actions.map(([, , reason]) => reason) : undefined;
  const index = await selectSummaryAction(ctx, title, rows, labels, undefined, disabled);
  return index === undefined ? undefined : actions[index]?.[1];
}

/** Read-only content doesn't need an editor in the TUI. */
export async function showGitDetails(ctx: ReviewContext, title: string, body: string): Promise<void> {
  if (ctx.mode !== "tui") {
    await ctx.ui.editor(title, body);
    return;
  }
  const content = textBody([body.trimEnd()]);
  await reviewDialog(ctx, title, () => content, []);
}
