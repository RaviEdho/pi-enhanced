import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  extractCoverageTerms,
  findUnselectedHunkMentions,
  formatSelectiveFileDiff,
  getFileDiff,
  getStagedOverview,
  type SelectiveDiffSnapshot,
} from "./git.js";
import type { CommitActionEntry, CommitHunkSelection, CommitPlanProposal, CommitProposal } from "./types.js";
import { DiffPageProperties, GitDiffPager, type DiffPageInput } from "./diff.js";

function normalizeCommitBody(value: unknown): string {
  const invalidBody = () => new Error(
    'Invalid commit body: provide at least 2 non-empty Markdown bullets ("- Why this changed\\n- Key change") or an array of strings. Correct the body and call the proposal tool again.'
  );

  // Some models serialize a bullet array into a string, sometimes twice.
  // Decode only JSON-shaped values; ordinary Markdown must stay untouched.
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    const text = value.trim();
    if (!text.startsWith("[") && !text.startsWith('"')) break;
    try {
      value = JSON.parse(text);
    } catch {
      throw invalidBody();
    }
  }

  let body: string;
  if (Array.isArray(value)) {
    if (!value.every((line): line is string => typeof line === "string" && line.trim().length > 0)) {
      throw invalidBody();
    }
    body = value.map((line: string) => {
      const text = line.trim().replace(/^[-*+•](?:[ \t]+|$)/, "");
      if (!text.trim()) throw invalidBody();
      return `- ${text}`;
    }).join("\n");
  } else if (typeof value === "string") {
    body = value.trim();
  } else {
    throw invalidBody();
  }

  // Validate before publishing a proposal, so neither the preview nor Git
  // receives a malformed body. Preserve wrapped lines and Markdown content.
  body = body.replace(/\r\n?/g, "\n").replace(/^[-*+•][ \t]+(?=\S)/gm, "- ");
  if ((body.match(/^- [^\S\n]*\S/gm) ?? []).length < 2) throw invalidBody();
  return body;
}

function parseCommitStage(item: any): CommitProposal {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error("Invalid commit stage: provide a subject and a body with at least 2 Markdown bullets.");
  }
  const commitType = typeof item.type === "string" && item.type.trim() ? item.type.trim() : "chore";
  const scope = item.scope && typeof item.scope === "string" ? item.scope.trim() : undefined;
  const rawSubject = item.subject || item.summary || "";
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";
  if (!subject) throw new Error("Invalid commit stage: provide a non-empty subject and call the proposal tool again.");

  const body = normalizeCommitBody(item.body);

  const files = Array.isArray(item.files)
    ? item.files
        .filter((f: any): f is string => typeof f === "string" && f.trim().length > 0)
        .map((f: string) => f.trim())
    : undefined;
  const hunks: CommitHunkSelection[] | undefined = Array.isArray(item.hunks)
    ? item.hunks
        .filter((selection: any) => selection && typeof selection.filePath === "string" && Array.isArray(selection.hunkIds))
        .map((selection: any) => ({
          filePath: selection.filePath.trim(),
          hunkIds: selection.hunkIds.filter((id: any): id is number => Number.isInteger(id)),
        }))
    : undefined;

  return {
    type: commitType,
    scope,
    subject,
    body,
    files,
    hunks,
  };
}

const HunkSelectionSchema = Type.Object({
  filePath: Type.String(),
  hunkIds: Type.Array(Type.Integer()),
});

const CommitBodySchema = Type.Optional(Type.Union([Type.String(), Type.Array(Type.String()), Type.Null()], {
  description: "Required: at least 2 Markdown bullets in one string, or an array of bullet strings. Do not JSON-encode the array into a string.",
}));

const CommitStageSchema = Type.Object({
  files: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  hunks: Type.Optional(Type.Union([Type.Array(HunkSelectionSchema), Type.Null()])),
  type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  body: CommitBodySchema,
});

export function createCommitTools(options: {
  cwd: string;
  onPropose: (plan: CommitPlanProposal) => void;
  onAction?: (action: Omit<CommitActionEntry, "timestamp">) => void;
  diffedFiles?: string[];
  selectiveSnapshot?: SelectiveDiffSnapshot;
  instruction?: string;
  signal?: AbortSignal;
}): ToolDefinition[] {
  const { cwd, onPropose, onAction, diffedFiles, selectiveSnapshot, instruction, signal } = options;
  const diffPages = new Map<string, Promise<GitDiffPager>>();

  // Tell the agent when unselected hunks mention the requested change, so it can
  // add them before finishing. The last proposal wins, so a corrected call
  // replaces the incomplete one.
  const coverageWarning = (stages: CommitProposal[]): string => {
    if (!selectiveSnapshot || !instruction) return "";
    const terms = extractCoverageTerms(instruction);
    const mentions = findUnselectedHunkMentions(selectiveSnapshot, stages, terms);
    if (mentions.length === 0) return "";
    const lines = mentions.map(
      (mention) => `  - ${mention.filePath} [HUNK ${mention.hunkId}] (${mention.terms.join(", ")}): ${mention.preview}`
    );
    return [
      "",
      "WARNING: these unselected hunks mention the requested change:",
      ...lines,
      "If they document or implement the same change, call the proposal tool again with those hunks added (the last proposal wins). Otherwise leave them out.",
    ].join("\n");
  };

  const gitOverviewTool: ToolDefinition<any, unknown> = {
    name: "git_overview",
    label: "Git Overview",
    description: selectiveSnapshot
      ? "Retrieve all working-tree changes (staged and unstaged) available for selective commit, with file paths and diff statistics."
      : "Retrieve list of all currently staged files and git diff statistics.",
    parameters: Type.Object({}),
    async execute() {
      if (signal?.aborted) {
        throw new Error("Commit cancelled by user.");
      }
      const overview = selectiveSnapshot
        ? { stagedFiles: selectiveSnapshot.files, statSummary: selectiveSnapshot.statSummary }
        : await getStagedOverview(cwd);
      const fileLabel = selectiveSnapshot ? "changed" : "staged";
      onAction?.({
        type: "overview",
        description: `Git overview: ${overview.stagedFiles.length} ${fileLabel} file(s)`,
      });

      const text = [
        `${selectiveSnapshot ? "Changed" : "Staged"} files count: ${overview.stagedFiles.length}`,
        `${selectiveSnapshot ? "Changed" : "Staged"} files:`,
        ...overview.stagedFiles.map((file) => `  - ${file}`),
        "",
        "Diff stat:",
        overview.statSummary || "(no diff summary)",
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: undefined,
      };
    },
  };

  const gitFileDiffTool: ToolDefinition<any, unknown> = {
    name: "git_file_diff",
    label: "Git File Diff",
    description: "Inspect a file diff in 16k-character pages (also bounded to 48KB/1800 lines). Preserves all changed lines and metadata; only unchanged context is compressed. Follow nextOffset until complete; raw=true restores context. Selective hunks retain their original numbers.",
    parameters: Type.Object({
      filePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      ...DiffPageProperties,
    }),
    async execute(_toolCallId, params: { filePath?: string | null } & DiffPageInput) {
      if (signal?.aborted) {
        throw new Error("Commit cancelled by user.");
      }
      const targetPath = params?.filePath?.trim();
      if (!targetPath) {
        return {
          content: [
            {
              type: "text",
              text: "Error: `filePath` parameter is required. Specify a file path returned from git_overview.",
            },
          ],
          details: undefined,
        };
      }

      if (diffedFiles && !diffedFiles.includes(targetPath)) {
        diffedFiles.push(targetPath);
      }

      onAction?.({
        type: "diff",
        description: `Inspected diff for ${targetPath}`,
      });

      let pending = diffPages.get(targetPath);
      if (!pending) {
        pending = (async () => {
          const diff = selectiveSnapshot
            ? (selectiveSnapshot.files.includes(targetPath)
                ? formatSelectiveFileDiff(selectiveSnapshot, targetPath)
                : `(No changes found for ${targetPath})`)
            : await getFileDiff(targetPath, cwd);
          return new GitDiffPager(diff, "git diff (commit)");
        })();
        diffPages.set(targetPath, pending);
        void pending.catch(() => { diffPages.delete(targetPath); });
      }
      return (await pending).read(params, "git_file_diff", { filePath: targetPath });
    },
  };

  const proposeCommitTool: ToolDefinition<any, unknown> = {
    name: "propose_commit",
    label: "Propose Commit",
    description: "Submit a single commit proposal for one coherent concern. Keep a feature's implementation and its accompanying documentation together in this commit.",
    parameters: Type.Object({
      type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      body: CommitBodySchema,
      files: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
      hunks: Type.Optional(Type.Union([Type.Array(HunkSelectionSchema), Type.Null()])),
      commits: Type.Optional(Type.Union([Type.Array(CommitStageSchema), Type.Null()])),
    }),
    async execute(
      _toolCallId,
      params: {
        type?: string | null;
        scope?: string | null;
        subject?: string | null;
        summary?: string | null;
        body?: string | unknown[] | null;
        files?: string[] | null;
        hunks?: CommitHunkSelection[] | null;
        commits?: any[] | null;
      }
    ) {
      if (Array.isArray(params.commits) && params.commits.length > 0) {
        // Validate all stages before recording any; never silently drop one.
        const stages = params.commits.map((c) => parseCommitStage(c));

        if (stages.length > 0) {
          const headerLines = stages.map((s) =>
            s.scope ? `${s.type}(${s.scope}): ${s.subject}` : `${s.type}: ${s.subject}`
          );
          onAction?.({
            type: "proposal",
            description: `Proposed ${stages.length} atomic commit(s): ${headerLines.join("; ")}`,
          });
          onPropose({
            isMultiStage: stages.length > 1,
            stages,
          });
          return {
            content: [{ type: "text", text: `Multi-stage commit plan with ${stages.length} commit(s) recorded.${coverageWarning(stages)}` }],
            details: undefined,
          };
        }
      }

      const single = parseCommitStage(params);
      if (single) {
        const headerLine = single.scope
          ? `${single.type}(${single.scope}): ${single.subject}`
          : `${single.type}: ${single.subject}`;

        onAction?.({
          type: "proposal",
          description: `Proposed: ${headerLine}`,
        });

        onPropose({
          isMultiStage: false,
          stages: [single],
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Commit proposal received and recorded. Done.${coverageWarning([single])}`,
          },
        ],
        details: undefined,
      };
    },
  };

  const proposeCommitsTool: ToolDefinition<any, unknown> = {
    name: "propose_commits",
    label: "Propose Multiple Commits",
    description: "Submit an ordered plan of multiple atomic stages for genuinely independent concerns. Documentation explaining or enabling a feature must be assigned to the same stage as that feature; do not create a separate docs stage for it.",
    parameters: Type.Object({
      commits: Type.Array(CommitStageSchema),
    }),
    async execute(_toolCallId, params: { commits: any[] }) {
      const rawCommits = Array.isArray(params?.commits) ? params.commits : [];
      const stages = rawCommits.map((c) => parseCommitStage(c));

      if (stages.length === 0) {
        throw new Error("No commit stages provided. Call propose_commits again with at least one valid stage.");
      }

      const headerLines = stages.map((s) =>
        s.scope ? `${s.type}(${s.scope}): ${s.subject}` : `${s.type}: ${s.subject}`
      );

      onAction?.({
        type: "proposal",
        description: `Proposed ${stages.length} atomic commits: ${headerLines.join("; ")}`,
      });

      onPropose({
        isMultiStage: stages.length > 1,
        stages,
      });

      return {
        content: [
          {
            type: "text",
            text: `Multi-commit plan with ${stages.length} atomic stage(s) recorded.${coverageWarning(stages)}`,
          },
        ],
        details: undefined,
      };
    },
  };

  return [gitOverviewTool, gitFileDiffTool, proposeCommitTool, proposeCommitsTool];
}
