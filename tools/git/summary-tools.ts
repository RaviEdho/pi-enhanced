import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DiffPageProperties, GitDiffPager, SUMMARY_DIFF_PAGE_CHARS, type DiffPageInput } from "./diff.js";
import type { GitSummaryProposal } from "./types.js";

/** Capture a structured result, keeping action instructions separate from display labels. */
export function createSummaryProposalTool(onProposal: (proposal: GitSummaryProposal) => void): ToolDefinition<any, unknown> {
  return {
    name: "git_summary_propose",
    label: "Summary and Commit Topics",
    description: "Finish the summary with Markdown and the fewest coherent commit topics. Default to one proposal for one end-to-end feature, including its UI, routing, integrations, docs, and related fixes. Split only genuinely independent changes that can be reviewed and reverted separately; eight is a maximum, not a target. This only proposes actions; it does not stage or commit anything. Call after inspecting all changes.",
    parameters: Type.Object({
      summary: Type.String({ minLength: 1, description: "Human-readable Markdown summary" }),
      commits: Type.Array(Type.Object({
        topic: Type.String({ minLength: 1, maxLength: 73, description: "Short unique topic, without the leading word Commit" }),
        instruction: Type.String({ minLength: 1, maxLength: 1200, description: "Self-contained selective commit instruction: behavior, relevant paths, associated docs, and exclusions. No slash commands or CLI flags." }),
      }), { minItems: 1, maxItems: 8, description: "Prefer one commit for one feature. Use multiple commits only for genuinely independent changes, never separate layers or interfaces of the same feature." }),
    }),
    async execute(_id, params: GitSummaryProposal) {
      const proposal = {
        summary: params.summary.trim(),
        commits: params.commits.map(({ topic, instruction }) => ({ topic: topic.trim().replace(/\s+/g, " "), instruction: instruction.trim() })),
      };
      const topics = new Set(proposal.commits.map(({ topic }) => topic.toLowerCase()));
      if (!proposal.summary || proposal.commits.some(({ topic, instruction }) => !topic || !instruction) || topics.size !== proposal.commits.length) {
        throw new Error("Provide a nonempty summary and distinct, nonempty commit topics and instructions.");
      }
      onProposal(proposal);
      return { content: [{ type: "text", text: "Summary and commit topics prepared for user review." }], details: {}, terminate: true };
    },
  };
}

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
