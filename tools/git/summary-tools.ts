import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DiffPageProperties, GitDiffPager, SUMMARY_DIFF_PAGE_CHARS, type DiffPageInput } from "./diff.js";

/** Read-only tools scoped to the summary's tracked diff and listed untracked files. */
export function createSummaryTools(cwd: string, diff: string, untracked: string[]): ToolDefinition<any, unknown>[] {
  const pages = new GitDiffPager(diff || "(No tracked textual diff)", "git diff (summary)");
  const files = new Map<string, Promise<GitDiffPager>>();
  const allowed = new Set(untracked);
  return [
    {
      name: "git_summary_diff",
      label: "Summary Diff",
      description: "Read the tracked diff in 32k-character pages (48KB/1800 lines max). Preserves changed lines and metadata; only unchanged context is compressed. Follow nextOffset until complete; raw=true restores context.",
      parameters: Type.Object(DiffPageProperties),
      async execute(_id, params: DiffPageInput) {
        return pages.read(params, "git_summary_diff", {}, SUMMARY_DIFF_PAGE_CHARS);
      },
    },
    {
      name: "git_summary_file",
      label: "Summary Untracked File",
      description: "Read a listed untracked file in 32k-character pages (48KB/1800 lines max). Binary, non-regular files and files over 10MB are explicitly omitted. Follow nextOffset until complete.",
      parameters: Type.Object({ filePath: Type.String(), ...DiffPageProperties }),
      async execute(_id, params: DiffPageInput & { filePath: string }) {
        if (!allowed.has(params.filePath)) throw new Error("Choose a file from the untracked file list.");
        let pending = files.get(params.filePath);
        if (!pending) {
          pending = (async () => {
            const full = path.join(cwd, params.filePath);
            const stat = await fs.lstat(full);
            let text: string;
            if (!stat.isFile() || stat.size > 10 * 1024 * 1024) {
              text = "[Content omitted: not a regular file or larger than 10MB]";
            } else {
              const data = await fs.readFile(full);
              text = data.includes(0) ? "[Binary content omitted]" : data.toString("utf8");
            }
            return new GitDiffPager(text, "untracked file (summary)", false);
          })();
          files.set(params.filePath, pending);
          void pending.catch(() => { files.delete(params.filePath); });
        }
        return (await pending).read(params, "git_summary_file", { filePath: params.filePath }, SUMMARY_DIFF_PAGE_CHARS);
      },
    },
  ];
}
