import { getSettingsListTheme, keyHint, rawKeyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Input, Loader, matchesKey, visibleWidth, type Component, type Focusable, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DialogFrame, renderDialogActions } from "../../ux/dialog.js";
import { branchNameProblem } from "./branch-runner.js";
import { selectGitMenu, type GitMenuAction } from "./review-dialog.js";

const SUGGEST = "Suggest branch names";
const PLACEHOLDER = "Type a custom branch name…";
const SUGGESTION_ERROR = "Could not generate branch names. Try again or type your own.";
const NO_NAMES = "No usable branch names suggested. Try again or type your own.";

type BranchNamePrompt = {
  title: string;
  current: string;
  confirmHint: string;
  suggestions: { load: (signal?: AbortSignal) => Promise<string[]> } | { disabled: string };
};

class ActionSpinner extends Loader {
  indicator(): string {
    return this.getRenderedIndicator();
  }
}

export async function promptBranchName(ctx: ExtensionCommandContext, options: BranchNamePrompt): Promise<string | undefined> {
  const { title, current, confirmHint, suggestions } = options;
  const suggestDisabled = "disabled" in suggestions ? suggestions.disabled : undefined;
  if (ctx.mode !== "tui") {
    let names: string[] = [];
    while (true) {
      const actions: GitMenuAction[] = [["Type a custom branch name", "custom"], ...(names.length
        ? names.map((name, index): GitMenuAction => [name, `name-${index}`])
        : [[SUGGEST, "suggest", suggestDisabled] as const])];
      const choice = await selectGitMenu(ctx, title, [["Current", current]], actions);
      if (!choice) return;
      if (choice === "custom") {
        const name = (await ctx.ui.input("New branch name", PLACEHOLDER))?.trim();
        if (!name) return;
        const problem = await branchNameProblem(ctx.cwd, name);
        if (!problem) return name;
        ctx.ui.notify(problem, "warning");
      } else if (choice === "suggest" && "load" in suggestions) {
        ctx.ui.setWorkingMessage?.("Suggesting branch names…");
        try {
          names = await suggestions.load();
          if (!names.length) ctx.ui.notify(NO_NAMES, "warning");
        } catch {
          ctx.ui.notify(SUGGESTION_ERROR, "warning");
        } finally {
          ctx.ui.setWorkingMessage?.();
        }
      } else return names[Number(choice.slice("name-".length))];
    }
  }

  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const frame = new DialogFrame(tui, theme);
    const input = new Input({ prompt: "", placeholder: PLACEHOLDER, placeholderStyle: text => theme.fg("dim", text) });
    const controller = new AbortController();
    let spinner: ActionSpinner | undefined;
    let names: string[] = [];
    let selected = 0;
    let validating = false;
    let nameProblem: string | undefined;
    let suggestionProblem: string | undefined;

    const dispose = () => {
      controller.abort();
      spinner?.stop();
      spinner = undefined;
    };
    const finish = (name?: string) => { dispose(); done(name); };
    const select = (index: number) => {
      selected = index;
      frame.followActions();
      tui.requestRender();
    };

    const submit = async () => {
      const name = (selected === 0 ? input.getValue() : names[selected - 1] ?? "").trim();
      if (validating) return;
      validating = true;
      try {
        const problem = await branchNameProblem(ctx.cwd, name);
        if (controller.signal.aborted) return;
        if (!problem) return finish(name);
        nameProblem = problem;
      } catch {
        if (!controller.signal.aborted) nameProblem = "Could not check the branch name.";
      } finally {
        validating = false;
        if (!controller.signal.aborted) tui.requestRender();
      }
    };

    const suggest = async () => {
      if (!("load" in suggestions) || spinner) return;
      suggestionProblem = undefined;
      spinner = new ActionSpinner(tui, text => theme.fg("accent", text), text => text);
      try {
        const result = await suggestions.load(controller.signal);
        if (controller.signal.aborted) return;
        names = result;
        suggestionProblem = names.length ? undefined : NO_NAMES;
      } catch {
        if (!controller.signal.aborted) suggestionProblem = SUGGESTION_ERROR;
      } finally {
        spinner?.stop();
        spinner = undefined;
        if (!controller.signal.aborted) tui.requestRender();
      }
    };

    const activate = () => {
      if (selected === 0 || names.length) void submit();
      else void suggest();
    };

    const component: Component & Focusable & { dispose(): void } = {
      focused: false,
      capturesViewportInput: true,
      dispose,
      invalidate() { input.invalidate(); },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "app.interrupt") || data === "\x03") {
          finish();
          return true;
        }
        if (frame.handleInput(data)) return true;
        if (keys.matches(data, "tui.select.confirm")) {
          if (frame.refocusScrolledAction(selected)) tui.requestRender();
          else activate();
          return true;
        }
        const up = keys.matches(data, "tui.select.up") || matchesKey(data, "shift+tab") || (selected !== 0 && data === "k");
        if (up || keys.matches(data, "tui.select.down") || matchesKey(data, "tab") || (selected !== 0 && data === "j")) {
          select(Math.max(0, Math.min(suggestDisabled ? 0 : names.length || 1, selected + (up ? -1 : 1))));
          return true;
        }
        if (selected !== 0) return false;
        const before = input.getValue();
        input.handleInput(data);
        if (input.getValue() !== before) nameProblem = undefined;
        tui.requestRender();
        return true;
      },
      handleMouse(event: TuiMouseEvent) {
        const row = frame.actionRowAt(event.y);
        if (row !== undefined && event.type === "wheel" && event.wheelDelta) {
          frame.scrollActionsBy(event.wheelDelta);
          return { handled: true, render: true };
        }
        if (row === undefined || event.button !== "left" || (event.type !== "press" && event.type !== "click")) return frame.handleMouse(event);
        if (row !== 0 && suggestDisabled) return { handled: true };
        select(row);
        if (row !== 0 && event.type === "click") activate();
        return { handled: true, render: true };
      },
      render(width: number) {
        const label = spinner ? "Suggesting branch names…" : SUGGEST;
        const actions = renderDialogActions([PLACEHOLDER, ...(names.length ? names : [label])], selected, width);
        input.focused = this.focused && selected === 0;
        const prefix = selected === 0 ? `  ${getSettingsListTheme().cursor}` : "    ";
        actions[0] = `${prefix}${input.render(Math.max(1, width - visibleWidth(prefix)))[0]}`;
        if (suggestDisabled || spinner) {
          const arrow = selected === 1 ? getSettingsListTheme().cursor : "  ";
          const detail = spinner ? `${spinner.indicator()} ${theme.fg("muted", label)}` : theme.fg("dim", `${SUGGEST} · ${suggestDisabled}`);
          actions[1] = `  ${arrow}${detail}`;
        }
        return frame.render(width, {
          title,
          content: [`  ${theme.fg("muted", "Current:")} ${current.replace(/\p{Bidi_Control}/gu, "")}`,
            ...[nameProblem, suggestionProblem].flatMap(problem => problem ? [`  ${theme.fg("warning", problem)}`] : [])],
          actions,
          actionFocusLine: selected,
          hints: [rawKeyHint("↑/↓", "choose"),
            ...(spinner && selected !== 0 ? [] : [keyHint("tui.select.confirm", selected === 0 || names.length ? confirmHint : "suggest")]),
            keyHint("tui.select.cancel", "close")],
        });
      },
    };
    return component;
  }, { blocked: { kind: "question", message: title } });
}
