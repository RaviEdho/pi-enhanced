import { parseDocument } from "yaml";
import { execGit } from "./git.js";

export type TagPushWorkflow = "found" | "missing" | "unknown";

const MAX_WORKFLOWS = 40;
const MAX_WORKFLOW_BYTES = 1024 * 1024;
const BATCH_SIZE = 8;

function inspectTrigger(source: string): TagPushWorkflow {
  const document = parseDocument(source);
  if (document.errors.length || document.warnings.length) return "unknown";
  const workflow: unknown = document.toJS({ mapAsMap: true, maxAliasCount: 30 });
  if (!(workflow instanceof Map)) return "unknown";
  const on: unknown = workflow.get("on");
  if (typeof on === "string") return on === "push" ? "found" : "missing";
  if (Array.isArray(on)) return on.includes("push") ? "found" : "missing";
  if (on == null) return "missing";
  if (!(on instanceof Map)) return "unknown";
  if (!on.has("push")) return "missing";
  const push: unknown = on.get("push");
  if (push == null) return "found";
  if (!(push instanceof Map)) return "unknown";

  const include = push.has("tags");
  const exclude = push.has("tags-ignore");
  if (include && exclude) return "unknown";
  if (include || exclude) {
    const patterns: unknown = push.get(include ? "tags" : "tags-ignore");
    if (!Array.isArray(patterns) || !patterns.every(pattern => typeof pattern === "string" && pattern.length > 0)) return "unknown";
    // Look for a tag trigger, not a match for a specific version (not chosen yet).
    if (include) return patterns.some(pattern => !pattern.startsWith("!")) ? "found" : "missing";
    return patterns.includes("**") ? "missing" : "found";
  }
  // Without ref filters, push covers both branches and tags. Path filters only affect branches.
  return push.has("branches") || push.has("branches-ignore") ? "missing" : "found";
}

/** Inspect only committed, direct children of .github/workflows, without fetching missing Git objects. */
export async function readTagPushWorkflow(cwd: string): Promise<TagPushWorkflow> {
  const git = (args: string[]) => execGit(args, cwd, { GIT_NO_LAZY_FETCH: "1" }, 2_000);
  try {
    const tree = await git(["ls-tree", "-lz", "--full-tree", "HEAD", "--", ".github/workflows/"]);
    const files = tree.split("\0").flatMap(entry => {
      const match = /^100(?:644|755) blob ([a-f0-9]+) +(\S+)\t\.github\/workflows\/[^/]+\.(?:yml|yaml)$/.exec(entry);
      return match ? [{ blob: match[1]!, bytes: Number(match[2]) }] : [];
    });
    // Bound the menu probe; large or unreadable workflows are inconclusive, not evidence of no trigger.
    const candidates = files.slice(0, MAX_WORKFLOWS);
    let result: TagPushWorkflow = files.length > candidates.length ? "unknown" : "missing";
    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
      const checks = await Promise.all(candidates.slice(i, i + BATCH_SIZE).map(async ({ blob, bytes }) => {
        if (!Number.isFinite(bytes) || bytes > MAX_WORKFLOW_BYTES) return "unknown";
        try {
          return inspectTrigger(await git(["cat-file", "blob", blob]));
        } catch {
          return "unknown";
        }
      }));
      if (checks.includes("found")) return "found";
      if (checks.includes("unknown")) result = "unknown";
    }
    return result;
  } catch {
    return "unknown";
  }
}
