import type { ParsedOutput } from "./types.js";

export interface GitDiffCompression extends ParsedOutput {
  /** Attribute savings only to compact pages actually delivered to the agent. */
  savings: { endOffset: number; savedBytes: number }[];
}

/**
 * Agent-safe diff compression. Unlike the shell parser, never cap changes or
 * collapse generated files. Only shorten runs of unchanged hunk context, keeping
 * both edges. Preserve metadata (including modes/renames), hunk IDs and +/- lines.
 * This is an inspection view, not an applyable patch; callers retain the raw diff.
 */
export function compressGitDiff(raw: string): GitDiffCompression {
  const lines = raw.split("\n");
  const output: string[] = [];
  const savings: GitDiffCompression["savings"] = [];
  let outputChars = 0;
  const append = (text: string) => {
    outputChars += text.length + (output.length ? 1 : 0);
    output.push(text);
  };
  let inHunk = false;
  let lossy = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) inHunk = false;
    if (/^(?:\[HUNK \d+\] )?@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) inHunk = true;
    if (inHunk && line.startsWith(" ")) {
      let end = i + 1;
      while (end < lines.length && lines[end].startsWith(" ")) end++;
      const count = end - i;
      const marker = `[${count - 2} unchanged context lines omitted]`;
      const original = lines.slice(i, end).join("\n");
      const compact = `${line}\n${marker}\n${lines[end - 1]}`;
      if (count > 2 && compact.length < original.length) {
        append(compact);
        savings.push({ endOffset: outputChars, savedBytes: Buffer.byteLength(original) - Buffer.byteLength(compact) });
        lossy = true;
      } else {
        append(original);
      }
      i = end - 1;
      continue;
    }
    append(line);
  }

  return { text: output.join("\n"), lossy, savings };
}
