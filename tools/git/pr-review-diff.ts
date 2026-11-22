import { keyHint, rawKeyHint, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { DialogFrame } from "../../ux/dialog.js";
import { GitDiffPager } from "./diff.js";

/** Browse the same captured patch used by the review agent, without checking it out. */
export async function showPrReviewDiff(ctx: ExtensionCommandContext, title: string, diff: string): Promise<void> {
  const pager = new GitDiffPager(diff, "gh pr diff (preview)", false);
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    const frame = new DialogFrame(tui, theme);
    const offsets = [0];
    let index = 0;
    let next: number | null = null;
    let lines: string[] = [];
    const load = () => {
      const offset = offsets[index];
      next = pager.read({ offset, raw: true }, "git_pr_review_diff", {}, 8_000).details.nextOffset;
      lines = diff.slice(offset, next ?? diff.length).replace(/\n$/, "").split("\n").map((line) => {
        const color = line.startsWith("+") ? "toolDiffAdded" : line.startsWith("-") ? "toolDiffRemoved" : "text";
        return theme.fg(color, line.replaceAll("\t", "    "));
      });
      frame.resetScroll();
      tui.requestRender();
    };
    load();
    return {
      invalidate() {},
      handleInput(data) {
        if (keys.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) { done(); return true; }
        if (frame.handleInput(data)) return true;
        if (matchesKey(data, "up") || matchesKey(data, "down")) {
          frame.scrollBy(matchesKey(data, "up") ? -1 : 1);
          return true;
        }
        if (matchesKey(data, "left")) {
          if (index > 0) { index--; load(); }
          return true;
        }
        if (matchesKey(data, "right")) {
          if (next !== null) { offsets[++index] = next; load(); }
          return true;
        }
        return false;
      },
      handleMouse: (event) => frame.handleMouse(event),
      render: (width) => frame.render(width, {
        title, metadata: `Diff page ${index + 1}${next === null ? " (last)" : ""}`, content: lines,
        hints: [rawKeyHint("←/→", "change page"), keyHint("tui.select.cancel", "close diff")],
      }),
    };
  });
}
