import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  execGit,
  getBranchDiffSummary,
  getBranchFullDiff,
  getConflictFiles,
} from "./git.js";

export interface PullRequestProposal {
  title: string;
  summary: string;
  changes: string[];
  testing: string;
  notes?: string;
  markdown: string;
}

export interface ConflictResolutionProposal {
  filePath: string;
  resolvedContent: string;
  explanation: string;
}

/**
 * Creates specialized tools for the PR generation sub-agent.
 */
export function createPrTools(
  baseBranch: string,
  cwd: string,
  onProposal: (pr: PullRequestProposal) => void
): ToolDefinition<any, unknown>[] {
  const branchOverviewTool: ToolDefinition<any, unknown> = {
    name: "git_branch_overview",
    label: "Git Branch Overview",
    description: "Inspect branch commits and diffstat relative to base branch",
    parameters: Type.Object({}),
    execute: async () => {
      const summary = await getBranchDiffSummary(baseBranch, cwd);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
        details: undefined,
      };
    },
  };

  const branchDiffTool: ToolDefinition<any, unknown> = {
    name: "git_branch_diff",
    label: "Git Branch Diff",
    description: "Inspect the raw diff between base branch and current branch",
    parameters: Type.Object({}),
    execute: async () => {
      const diff = await getBranchFullDiff(baseBranch, cwd);
      return {
        content: [
          {
            type: "text",
            text: diff,
          },
        ],
        details: undefined,
      };
    },
  };

  const proposePrTool: ToolDefinition<any, unknown> = {
    name: "propose_pr",
    label: "Propose PR",
    description: "Propose the final Pull Request title, description, and structured markdown body",
    parameters: Type.Object({
      title: Type.String({ description: "Pull Request title (Conventional Commit style, imperative mood)" }),
      summary: Type.String({ description: "High-level overview of what this PR introduces or fixes" }),
      changes: Type.Array(Type.String(), { description: "List of key architectural or behavioral changes" }),
      testing: Type.String({ description: "Testing performed or verification steps" }),
      notes: Type.Optional(Type.String({ description: "Any breaking changes, migration steps, or extra notes" })),
    }),
    execute: async (_toolCallId, params: {
      title: string;
      summary: string;
      changes: string[];
      testing: string;
      notes?: string;
    }) => {
      const changesList = (params.changes || []).map((c) => `- ${c}`).join("\n");
      const notesSection = params.notes ? `\n### Notes & Breaking Changes\n${params.notes}\n` : "";

      const markdown = `## Summary\n${params.summary}\n\n### Key Changes\n${changesList}\n\n### Testing & Verification\n${params.testing}${notesSection}`;

      const proposal: PullRequestProposal = {
        title: params.title,
        summary: params.summary,
        changes: params.changes || [],
        testing: params.testing,
        notes: params.notes,
        markdown,
      };

      onProposal(proposal);

      return {
        content: [
          {
            type: "text",
            text: `Proposed PR: "${params.title}" with ${(params.changes || []).length} change bullets.`,
          },
        ],
        details: undefined,
      };
    },
  };

  return [branchOverviewTool, branchDiffTool, proposePrTool];
}

/**
 * Creates specialized tools for conflict resolution.
 */
export function createConflictTools(
  cwd: string,
  onResolve: (res: ConflictResolutionProposal) => void
): ToolDefinition<any, unknown>[] {
  const conflictFilesTool: ToolDefinition<any, unknown> = {
    name: "git_conflict_files",
    label: "Git Conflict Files",
    description: "List all files in repository currently containing git merge conflicts",
    parameters: Type.Object({}),
    execute: async () => {
      const files = await getConflictFiles(cwd);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              files.map((f) => ({
                path: f.path,
                hunkCount: f.hunkCount,
                preview: f.content.slice(0, 1500),
              })),
              null,
              2
            ),
          },
        ],
        details: undefined,
      };
    },
  };

  const proposeConflictResolutionTool: ToolDefinition<any, unknown> = {
    name: "propose_conflict_resolution",
    label: "Propose Conflict Resolution",
    description: "Propose the resolved content of a conflicted file without conflict markers",
    parameters: Type.Object({
      filePath: Type.String({ description: "Relative file path of the conflicted file" }),
      resolvedContent: Type.String({ description: "Entire resolved file content with conflict markers cleanly resolved" }),
      explanation: Type.String({ description: "Brief explanation of how the conflicting changes were merged" }),
    }),
    execute: async (_toolCallId, params: {
      filePath: string;
      resolvedContent: string;
      explanation: string;
    }) => {
      onResolve({
        filePath: params.filePath,
        resolvedContent: params.resolvedContent,
        explanation: params.explanation,
      });
      return {
        content: [
          {
            type: "text",
            text: `Conflict resolution proposed for ${params.filePath}: ${params.explanation}`,
          },
        ],
        details: undefined,
      };
    },
  };

  return [conflictFilesTool, proposeConflictResolutionTool];
}
