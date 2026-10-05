import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getFileDiff, getStagedOverview } from "./git.js";
import type { CommitActionEntry, CommitPlanProposal, CommitProposal } from "./types.js";

function parseCommitStage(item: any): CommitProposal | null {
  if (!item || typeof item !== "object") return null;
  const commitType = (item.type || "chore").trim();
  const scope = item.scope && typeof item.scope === "string" ? item.scope.trim() : undefined;
  const rawSubject = item.subject || item.summary || "";
  const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";
  if (!subject) return null;

  let body: string | undefined;
  if (typeof item.body === "string" && item.body.trim()) {
    body = item.body.trim();
  } else if (Array.isArray(item.body)) {
    const lines = item.body
      .filter((l: any): l is string => typeof l === "string" && l.trim().length > 0)
      .map((line: string) => (line.trim().startsWith("-") ? line.trim() : `- ${line.trim()}`));
    if (lines.length > 0) {
      body = lines.join("\n");
    }
  }

  const files = Array.isArray(item.files)
    ? item.files
        .filter((f: any): f is string => typeof f === "string" && f.trim().length > 0)
        .map((f: string) => f.trim())
    : undefined;

  return {
    type: commitType,
    scope,
    subject,
    body,
    files,
  };
}

const CommitStageSchema = Type.Object({
  files: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  body: Type.Optional(Type.Union([Type.String(), Type.Array(Type.Any()), Type.Null()])),
});

export function createCommitTools(options: {
  cwd: string;
  onPropose: (plan: CommitPlanProposal) => void;
  onAction?: (action: Omit<CommitActionEntry, "timestamp">) => void;
  diffedFiles?: string[];
  signal?: AbortSignal;
}): ToolDefinition[] {
  const { cwd, onPropose, onAction, diffedFiles, signal } = options;

  const gitOverviewTool: ToolDefinition<any, unknown> = {
    name: "git_overview",
    label: "Git Overview",
    description: "Retrieve list of all currently staged files and git diff statistics.",
    parameters: Type.Object({}),
    async execute() {
      if (signal?.aborted) {
        throw new Error("Commit cancelled by user.");
      }
      const overview = await getStagedOverview(cwd);
      onAction?.({
        type: "overview",
        description: `Git overview: ${overview.stagedFiles.length} file(s) staged`,
      });

      const text = [
        `Staged files count: ${overview.stagedFiles.length}`,
        "Staged files:",
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
    description: "Get cached git diff for a specific staged file. Automatically omits lockfiles and truncates oversized outputs.",
    parameters: Type.Object({
      filePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    async execute(_toolCallId, params: { filePath?: string | null }) {
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

      const diff = await getFileDiff(targetPath, cwd);
      return {
        content: [{ type: "text", text: diff }],
        details: undefined,
      };
    },
  };

  const proposeCommitTool: ToolDefinition<any, unknown> = {
    name: "propose_commit",
    label: "Propose Commit",
    description: "Submit a single commit proposal when all inspected changes belong to one coherent concern.",
    parameters: Type.Object({
      type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      body: Type.Optional(Type.Union([Type.String(), Type.Array(Type.Any()), Type.Null()])),
      files: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
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
        commits?: any[] | null;
      }
    ) {
      if (Array.isArray(params.commits) && params.commits.length > 0) {
        const stages = params.commits
          .map((c) => parseCommitStage(c))
          .filter((c): c is CommitProposal => c !== null);

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
            content: [{ type: "text", text: `Multi-stage commit plan with ${stages.length} commit(s) recorded.` }],
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
            text: "Commit proposal received and recorded. Done.",
          },
        ],
        details: undefined,
      };
    },
  };

  const proposeCommitsTool: ToolDefinition<any, unknown> = {
    name: "propose_commits",
    label: "Propose Multiple Commits",
    description: "Submit an ordered plan of multiple atomic commit stages when staged changes span multiple distinct concerns (e.g. feature + bugfix + docs).",
    parameters: Type.Object({
      commits: Type.Array(CommitStageSchema),
    }),
    async execute(_toolCallId, params: { commits: any[] }) {
      const rawCommits = Array.isArray(params?.commits) ? params.commits : [];
      const stages = rawCommits
        .map((c) => parseCommitStage(c))
        .filter((c): c is CommitProposal => c !== null);

      if (stages.length === 0) {
        return {
          content: [{ type: "text", text: "Error: No valid commit stages provided." }],
          details: undefined,
        };
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
            text: `Multi-commit plan with ${stages.length} atomic stage(s) recorded. Done.`,
          },
        ],
        details: undefined,
      };
    },
  };

  return [gitOverviewTool, gitFileDiffTool, proposeCommitTool, proposeCommitsTool];
}
