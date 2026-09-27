import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getFileDiff, getStagedOverview } from "./git.js";
import type { CommitActionEntry, CommitProposal } from "./types.js";

export function createCommitTools(options: {
  cwd: string;
  onPropose: (proposal: CommitProposal) => void;
  onAction?: (action: Omit<CommitActionEntry, "timestamp">) => void;
  diffedFiles?: string[];
}): ToolDefinition[] {
  const { cwd, onPropose, onAction, diffedFiles } = options;

  const gitOverviewTool: ToolDefinition<any, unknown> = {
    name: "git_overview",
    label: "Git Overview",
    description: "Retrieve list of all currently staged files and git diff statistics.",
    parameters: Type.Object({}),
    async execute() {
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
    description: "Submit the final commit message proposal once diffs are inspected.",
    parameters: Type.Object({
      type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      scope: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      subject: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      summary: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      body: Type.Optional(Type.Union([Type.String(), Type.Array(Type.Any()), Type.Null()])),
    }),
    async execute(
      _toolCallId,
      params: {
        type?: string | null;
        scope?: string | null;
        subject?: string | null;
        summary?: string | null;
        body?: string | unknown[] | null;
      }
    ) {
      const commitType = (params.type || "chore").trim();
      const scope = params.scope && typeof params.scope === "string" ? params.scope.trim() : undefined;
      const rawSubject = params.subject || params.summary || "";
      const subject = typeof rawSubject === "string" ? rawSubject.trim() : "";

      let body: string | undefined;
      if (typeof params.body === "string" && params.body.trim()) {
        body = params.body.trim();
      } else if (Array.isArray(params.body)) {
        const lines = params.body
          .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
          .map((line) => (line.trim().startsWith("-") ? line.trim() : `- ${line.trim()}`));
        if (lines.length > 0) {
          body = lines.join("\n");
        }
      }

      const headerLine = scope ? `${commitType}(${scope}): ${subject}` : `${commitType}: ${subject}`;
      onAction?.({
        type: "proposal",
        description: `Proposed: ${headerLine}`,
      });

      if (subject.length > 0) {
        onPropose({
          type: commitType,
          scope,
          subject,
          body,
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

  return [gitOverviewTool, gitFileDiffTool, proposeCommitTool];
}
