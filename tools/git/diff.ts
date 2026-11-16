import { Type } from "typebox";
import { EnhancedSettingsStore } from "../../ux/settings/store.js";
import { compressGitDiff, type GitDiffCompression } from "../compressor/git-diff.js";
import { GainTracker } from "../compressor/tracker.js";

export const COMMIT_DIFF_PAGE_CHARS = 16_000;
export const SUMMARY_DIFF_PAGE_CHARS = 32_000;
const MAX_PAGE_BYTES = 48_000;
const MAX_PAGE_LINES = 1800;

export const DiffPageProperties = {
  offset: Type.Optional(Type.Integer({ minimum: 0, description: "Character offset from nextOffset; start at 0. Offsets belong to the selected raw/compact view." })),
  raw: Type.Optional(Type.Boolean({ description: "Return original diff, including unchanged context. Restart offset at 0 when switching views." })),
};

export interface DiffPageInput {
  offset?: number;
  raw?: boolean;
}

/** A command-local immutable snapshot: paging never re-runs Git against newer edits. */
export class GitDiffPager {
  private readonly compact: string;
  private readonly savings: GitDiffCompression["savings"] = [];

  constructor(private readonly original: string, private readonly command: string, compress = true) {
    this.compact = original;
    if (compress && process.env.PI_COMPRESSOR_DISABLED !== "1" && process.env.PI_FILTER_DISABLED !== "1" &&
        EnhancedSettingsStore.getInstance().get("compressor.enabled")) {
      const result = compressGitDiff(original);
      this.compact = result.text;
      this.savings = result.savings;
    }
  }

  read(input: DiffPageInput, toolName: string, args: Record<string, string> = {}, maxChars = COMMIT_DIFF_PAGE_CHARS) {
    const text = input.raw ? this.original : this.compact;
    const offset = input.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) {
      throw new Error(`Invalid offset: use 0 or the nextOffset returned by ${toolName}.`);
    }
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? "") && /[\uD800-\uDBFF]/.test(text[offset - 1])) {
      throw new Error("Offset splits a Unicode character; use the returned nextOffset.");
    }

    let end = offset;
    let bytes = 0;
    let lines = 0;
    let lastNewline = offset;
    for (const char of text.slice(offset, offset + maxChars + 1)) {
      const size = Buffer.byteLength(char);
      if (end - offset + char.length > maxChars || bytes + size > MAX_PAGE_BYTES || lines >= MAX_PAGE_LINES) break;
      end += char.length;
      bytes += size;
      if (char === "\n") {
        lines++;
        lastNewline = end;
      }
    }
    // Prefer complete lines, but split very long lines rather than discarding them.
    if (end < text.length && lastNewline > offset) end = lastNewline;
    const nextOffset = end < text.length ? end : null;
    const continuation = nextOffset === null
      ? "[End of diff/content]"
      : `[More content: call ${toolName} with ${JSON.stringify({ ...args, offset: nextOffset, raw: input.raw ?? false })}]`;
    const compressed = !input.raw && this.compact !== this.original;
    if (compressed) {
      const savedBytes = this.savings.reduce((sum, span) => sum + (span.endOffset > offset && span.endOffset <= end ? span.savedBytes : 0), 0);
      if (savedBytes > 0) {
        const pageBytes = Buffer.byteLength(text.slice(offset, end));
        GainTracker.getInstance().record(this.command, "git-agent-diff", pageBytes + savedBytes, pageBytes);
      }
    }
    return {
      content: [{ type: "text" as const, text: [
        `[${input.raw ? "Raw" : "Inspection"} view; characters ${offset}-${end} of ${text.length}${compressed ? "; only unchanged context compressed; use raw=true, offset=0 to recover" : ""}]`,
        text.slice(offset, end),
        continuation,
      ].join("\n") }],
      details: { offset, nextOffset, totalChars: text.length, compressed, raw: input.raw ?? false },
    };
  }
}
