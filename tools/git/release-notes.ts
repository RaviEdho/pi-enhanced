import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { selectGitPicker } from "./review-dialog.js";
import { RELEASE_AGENT_SYSTEM_PROMPT } from "./smart-prompts.js";

export type ReleaseNotesContext = Pick<ExtensionCommandContext, "model" | "modelRegistry" | "signal" | "ui">;

const maxCommits = 100;
const maxInputChars = 12_000;
const maxNoteBytes = 24 * 1024;

export async function draftReleaseNotes(ctx: ReleaseNotesContext, commits: string[]): Promise<string | undefined> {
  if (!ctx.model) throw new Error("No model is selected.");
  if (!commits.length) return undefined;
  const text = commits.slice(0, maxCommits).join("\n");
  const truncated = commits.length > maxCommits || text.length > maxInputChars;
  ctx.ui.setWorkingMessage?.("Drafting release notes…");
  try {
    const response = await ctx.modelRegistry.complete(ctx.model, {
      systemPrompt: RELEASE_AGENT_SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Write release notes for the following commit subjects.\n${truncated ? "Only the most recent commits are included. Do not invent omitted changes.\n" : ""}\n${text.slice(0, maxInputChars)}`,
        timestamp: Date.now(),
      }],
    }, { signal: ctx.signal });
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      throw new Error("The model did not finish drafting release notes.");
    }
    return response.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim() || undefined;
  } finally {
    ctx.ui.setWorkingMessage?.();
  }
}

export async function chooseReleaseNotes(
  ctx: ReleaseNotesContext & Pick<ExtensionCommandContext, "mode">,
  tag: string,
  getCommits: () => Promise<string[]>,
): Promise<{ notes?: string } | undefined> {
  const ai = "Draft notes with AI";
  const manual = "Write notes manually";
  const skip = "Skip release notes";
  for (;;) {
    const selected = await selectGitPicker(ctx, "Release notes", [["Tag", tag], ["Saved in", "Annotated Git tag"]],
      [skip, ...(ctx.model ? [ai] : []), manual], `Release notes for ${tag}`);
    if (selected === skip) return {};
    if (selected !== ai && selected !== manual) return undefined;

    let draft = "";
    if (selected === ai) {
      try {
        const commits = await getCommits();
        if (!commits.length) {
          ctx.ui.notify("No commits since the previous tag. Write notes manually or skip them.", "info");
          continue;
        }
        draft = await draftReleaseNotes(ctx, commits) ?? "";
        if (!draft) {
          ctx.ui.notify("The model returned no release notes. Write them manually or skip them.", "warning");
          continue;
        }
      } catch {
        ctx.ui.notify("Could not draft release notes. Write them manually or skip them.", "warning");
        continue;
      }
    }

    for (;;) {
      const reviewed = await ctx.ui.editor(`Review notes for ${tag} (saved in the Git tag)`, draft);
      if (reviewed === undefined) return undefined;
      draft = reviewed.replace(/\r\n?/g, "\n").trim();
      if (!draft) return {};
      if (Buffer.byteLength(draft, "utf8") <= maxNoteBytes && !/[\x00-\x08\x0b-\x1f\x7f]/.test(draft)) {
        return { notes: draft };
      }
      ctx.ui.notify("Release notes must be under 24 KB and contain no terminal control characters.", "warning");
    }
  }
}
