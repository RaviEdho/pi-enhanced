import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeFind, executeGrep } from "./tools.js";

export type ParsedSearchCommand =
  | {
      type: "grep";
      pattern: string;
      path?: string;
      glob?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
      limit?: number;
    }
  | {
      type: "find";
      pattern?: string;
      path?: string;
      limit?: number;
    };

export interface SplitResult {
  tokens: string[];
  hasPipesOrRedirection: boolean;
}

/**
 * Split shell command string into tokens, preserving quoted arguments,
 * backslashes in regex patterns, and detecting unquoted shell operators.
 */
export function splitShellTokens(cmd: string): SplitResult {
  const tokens: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let hasPipesOrRedirection = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    // Inside single quotes: all characters are literal, NO escape processing
    if (inSingleQuote) {
      if (ch === "'") {
        inSingleQuote = false;
      } else {
        current += ch;
      }
      continue;
    }

    // Inside double quotes: only \", \\, \$, \` are escaped; others keep backslash
    if (inDoubleQuote) {
      if (ch === '"') {
        inDoubleQuote = false;
      } else if (ch === "\\") {
        const next = i + 1 < cmd.length ? cmd[i + 1] : "";
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          i++;
        } else {
          current += "\\";
        }
      } else {
        current += ch;
      }
      continue;
    }

    // Outside quotes: check quote openers
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }

    // Outside quotes: check unquoted shell operators
    if (ch === "|" || ch === "&" || ch === ";" || ch === ">" || ch === "<" || ch === "`" || ch === "\n") {
      hasPipesOrRedirection = true;
      continue;
    }

    // Outside quotes: backslash escape
    if (ch === "\\") {
      const next = i + 1 < cmd.length ? cmd[i + 1] : "";
      if (/\s/.test(next) || next === '"' || next === "'" || next === "\\") {
        current += next;
        i++;
      } else {
        // Keep backslash for regex constructs like \s, \w, \d
        current += "\\";
      }
      continue;
    }

    // Outside quotes: whitespace splits tokens
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return { tokens, hasPipesOrRedirection };
}

/**
 * Attempt to parse a standalone shell search command (rg, grep, ag, find, fd)
 * Returns null if the command is compound, contains pipes/redirection, or cannot be parsed.
 */
export function parseSearchCommand(rawCmd: string): ParsedSearchCommand | null {
  const trimmed = rawCmd.trim();
  if (!trimmed) return null;

  const { tokens, hasPipesOrRedirection } = splitShellTokens(trimmed);
  if (hasPipesOrRedirection || tokens.length === 0) {
    return null;
  }

  // Skip leading environment variable assignments (e.g. CI=1 or LC_ALL=C)
  let tokenIdx = 0;
  while (tokenIdx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[tokenIdx])) {
    tokenIdx++;
  }
  if (tokenIdx >= tokens.length) return null;

  const rawBin = tokens[tokenIdx];
  const bin = path.basename(rawBin).toLowerCase().replace(/\.exe$/, "");
  const args = tokens.slice(tokenIdx + 1);

  if (bin === "rg" || bin === "ripgrep") {
    return parseRgCommand(args);
  }
  if (bin === "grep" || bin === "egrep") {
    return parseGrepCommand(args);
  }
  if (bin === "ag") {
    return parseAgCommand(args);
  }
  if (bin === "find") {
    return parseFindCommand(args);
  }
  if (bin === "fd") {
    return parseFdCommand(args);
  }

  return null;
}

function parseRgCommand(args: string[]): ParsedSearchCommand | null {
  let isFilesMode = false;
  let pattern: string | undefined;
  let targetPath: string | undefined;
  let glob: string | undefined;
  let ignoreCase: boolean | undefined;
  let literal: boolean | undefined;
  let context: number | undefined;
  let limit: number | undefined;
  let wordRegexp = false;

  const positionals: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (endOfOptions) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (arg === "--files") {
      isFilesMode = true;
      continue;
    }
    if (arg === "-i" || arg === "--ignore-case") {
      ignoreCase = true;
      continue;
    }
    if (arg === "-s" || arg === "--case-sensitive") {
      ignoreCase = false;
      continue;
    }
    if (arg === "-S" || arg === "--smart-case") {
      ignoreCase = undefined;
      continue;
    }
    if (arg === "-F" || arg === "--fixed-strings") {
      literal = true;
      continue;
    }
    if (arg === "-w" || arg === "--word-regexp") {
      wordRegexp = true;
      continue;
    }

    // Output-shape changing flags cannot be faithfully reproduced by the
    // in-memory grep engine — let the real command run instead.
    if (
      arg === "-l" ||
      arg === "--files-with-matches" ||
      arg === "--files-without-match" ||
      arg === "-c" ||
      arg === "--count" ||
      arg === "--count-matches" ||
      arg === "-o" ||
      arg === "--only-matching" ||
      arg === "--json" ||
      arg === "--stats"
    ) {
      return null;
    }

    if (arg === "-e" || arg === "--regexp") {
      if (i + 1 < args.length) {
        pattern = args[++i];
      }
      continue;
    }
    if (arg.startsWith("-e")) {
      pattern = arg.slice(2);
      continue;
    }
    if (arg.startsWith("--regexp=")) {
      pattern = arg.slice(9);
      continue;
    }

    if (arg === "-g" || arg === "--glob") {
      if (i + 1 < args.length) {
        glob = args[++i];
      }
      continue;
    }
    if (arg.startsWith("--glob=")) {
      glob = arg.slice(7);
      continue;
    }
    if (arg.startsWith("-g")) {
      glob = arg.slice(2);
      continue;
    }

    // Type filter e.g. -t ts or --type ts
    if (arg === "-t" || arg === "--type") {
      if (i + 1 < args.length) {
        const typeVal = args[++i];
        glob = `*.${typeVal}`;
      }
      continue;
    }
    if (arg.startsWith("--type=")) {
      glob = `*.${arg.slice(7)}`;
      continue;
    }
    if (arg.startsWith("-t")) {
      glob = `*.${arg.slice(2)}`;
      continue;
    }

    if (arg === "-C" || arg === "-A" || arg === "-B") {
      if (i + 1 < args.length) {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) context = Math.max(context ?? 0, val);
      }
      continue;
    }
    if (/^-[CAB]\d+$/.test(arg)) {
      const val = parseInt(arg.slice(2), 10);
      if (!isNaN(val)) context = Math.max(context ?? 0, val);
      continue;
    }
    if (arg === "-m" || arg === "--max-count") {
      if (i + 1 < args.length) {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) limit = val;
      }
      continue;
    }
    if (arg.startsWith("--max-count=")) {
      const val = parseInt(arg.slice(12), 10);
      if (!isNaN(val)) limit = val;
      continue;
    }
    if (/^-m\d+$/.test(arg)) {
      const val = parseInt(arg.slice(2), 10);
      if (!isNaN(val)) limit = val;
      continue;
    }

    // Known flags with arguments that should be skipped without becoming positionals
    if (
      arg === "-d" ||
      arg === "--max-depth" ||
      arg === "-f" ||
      arg === "--file" ||
      arg === "-E" ||
      arg === "--encoding" ||
      arg === "--sort" ||
      arg === "--path-separator" ||
      arg === "-r" ||
      arg === "--replace" ||
      arg === "--ignore-file"
    ) {
      if (i + 1 < args.length) i++;
      continue;
    }
    if (
      arg.startsWith("--max-depth=") ||
      arg.startsWith("--file=") ||
      arg.startsWith("--encoding=") ||
      arg.startsWith("--sort=") ||
      arg.startsWith("--replace=") ||
      arg.startsWith("--ignore-file=")
    ) {
      continue;
    }

    if (arg.startsWith("-")) {
      continue;
    }

    positionals.push(arg);
  }

  if (isFilesMode) {
    targetPath = positionals[0];
    return {
      type: "find",
      path: targetPath,
      pattern: glob,
    };
  }

  if (!pattern && positionals.length > 0) {
    pattern = positionals.shift();
  }
  if (!targetPath && positionals.length > 0) {
    targetPath = positionals.shift();
  }

  if (!pattern) return null;

  if (wordRegexp && !literal) {
    pattern = `\\b${pattern}\\b`;
  }

  return {
    type: "grep",
    pattern,
    path: targetPath,
    glob,
    ignoreCase,
    literal,
    context,
    limit,
  };
}

function parseGrepCommand(args: string[]): ParsedSearchCommand | null {
  let pattern: string | undefined;
  let targetPath: string | undefined;
  let glob: string | undefined;
  let ignoreCase: boolean | undefined;
  let literal: boolean | undefined;
  let context: number | undefined;
  let limit: number | undefined;
  let wordRegexp = false;

  const positionals: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (endOfOptions) {
      positionals.push(arg);
      continue;
    }

    if (arg === "--") {
      endOfOptions = true;
      continue;
    }

    if (arg === "-e" || arg === "--regexp") {
      if (i + 1 < args.length) pattern = args[++i];
      continue;
    }
    if (arg.startsWith("-e")) {
      pattern = arg.slice(2);
      continue;
    }
    if (arg.startsWith("--regexp=")) {
      pattern = arg.slice(9);
      continue;
    }

    if (arg === "-w" || arg === "--word-regexp") {
      wordRegexp = true;
      continue;
    }

    if (arg.startsWith("--include=")) {
      glob = arg.slice(10);
      continue;
    }
    if (arg === "--include" && i + 1 < args.length) {
      glob = args[++i];
      continue;
    }
    if (arg.startsWith("--exclude=")) {
      glob = `!${arg.slice(10)}`;
      continue;
    }
    if (arg === "--exclude" && i + 1 < args.length) {
      glob = `!${args[++i]}`;
      continue;
    }

    if (arg === "-C" || arg === "-A" || arg === "-B") {
      if (i + 1 < args.length) {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) context = Math.max(context ?? 0, val);
      }
      continue;
    }
    if (/^-[CAB]\d+$/.test(arg)) {
      const val = parseInt(arg.slice(2), 10);
      if (!isNaN(val)) context = Math.max(context ?? 0, val);
      continue;
    }

    if (arg === "-m" || arg === "--max-count") {
      if (i + 1 < args.length) {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) limit = val;
      }
      continue;
    }
    if (arg.startsWith("--max-count=")) {
      const val = parseInt(arg.slice(12), 10);
      if (!isNaN(val)) limit = val;
      continue;
    }
    if (/^-m\d+$/.test(arg)) {
      const val = parseInt(arg.slice(2), 10);
      if (!isNaN(val)) limit = val;
      continue;
    }

    // Flags taking arguments to skip
    if (
      arg === "-d" ||
      arg === "--directories" ||
      arg === "-f" ||
      arg === "--file" ||
      arg === "--exclude-dir" ||
      arg === "--exclude-from"
    ) {
      if (i + 1 < args.length) i++;
      continue;
    }

    if (arg.startsWith("-") && !arg.startsWith("--")) {
      if (arg.includes("i")) ignoreCase = true;
      if (arg.includes("F")) literal = true;
      if (arg.includes("w")) wordRegexp = true;
      // Output-shape changing flags cannot be faithfully reproduced by the
      // in-memory grep engine — let the real command run instead.
      if (arg.includes("l") || arg.includes("c")) return null;
      continue;
    }

    if (arg.startsWith("--")) {
      if (arg === "--ignore-case") ignoreCase = true;
      if (arg === "--fixed-strings") literal = true;
      if (
        arg === "--files-with-matches" ||
        arg === "--files-without-match" ||
        arg === "--count" ||
        arg === "--count-matches" ||
        arg === "--only-matching"
      ) {
        return null;
      }
      continue;
    }

    positionals.push(arg);
  }

  if (!pattern && positionals.length > 0) {
    pattern = positionals.shift();
  }
  if (!targetPath && positionals.length > 0) {
    targetPath = positionals.shift();
  }

  if (!pattern) return null;

  if (wordRegexp && !literal) {
    pattern = `\\b${pattern}\\b`;
  }

  return {
    type: "grep",
    pattern,
    path: targetPath,
    glob,
    ignoreCase,
    literal,
    context,
    limit,
  };
}

function parseAgCommand(args: string[]): ParsedSearchCommand | null {
  let pattern: string | undefined;
  let targetPath: string | undefined;
  let glob: string | undefined;
  let ignoreCase: boolean | undefined;
  let literal: boolean | undefined;
  let context: number | undefined;

  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "-i" || arg === "--ignore-case") {
      ignoreCase = true;
      continue;
    }
    if (arg === "-s" || arg === "--case-sensitive") {
      ignoreCase = false;
      continue;
    }
    if (arg === "-S" || arg === "--smart-case") {
      ignoreCase = undefined;
      continue;
    }
    if (arg === "-F" || arg === "-Q" || arg === "--literal") {
      literal = true;
      continue;
    }
    if (arg === "-G" && i + 1 < args.length) {
      glob = args[++i];
      continue;
    }
    if (arg.startsWith("-G")) {
      glob = arg.slice(2);
      continue;
    }
    if ((arg === "-C" || arg === "-A" || arg === "-B") && i + 1 < args.length) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) context = val;
      continue;
    }
    if (arg.startsWith("-")) continue;

    positionals.push(arg);
  }

  if (positionals.length > 0) pattern = positionals.shift();
  if (positionals.length > 0) targetPath = positionals.shift();

  if (!pattern) return null;

  return {
    type: "grep",
    pattern,
    path: targetPath,
    glob,
    ignoreCase,
    literal,
    context,
  };
}

function normalizeFindGlobPattern(rawPattern: string): string {
  let p = rawPattern.trim().replace(/^["']|["']$/g, "");
  // Exact extension filter e.g. *.ts or *.{ts,tsx}
  if (/^\*\.[a-zA-Z0-9_-]+$/.test(p) || /^\*\.\{[a-zA-Z0-9_,-]+\}$/.test(p)) {
    return p;
  }
  // Strip leading/trailing wildcard asterisks for fuzzy matching
  if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
    p = p.slice(1, -1);
  } else if (p.startsWith("*") && p.length > 1) {
    p = p.slice(1);
  } else if (p.endsWith("*") && p.length > 1) {
    p = p.slice(0, -1);
  }
  return p;
}

function parseFindCommand(args: string[]): ParsedSearchCommand | null {
  // If find contains dangerous/mutating flags, do not intercept
  for (const a of args) {
    if (a === "-exec" || a === "-execdir" || a === "-delete" || a === "-ok" || a === "-okdir") {
      return null;
    }
  }

  let targetPath: string | undefined;
  let pattern: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Positionals before any flag are target paths
    if (!arg.startsWith("-")) {
      if (!targetPath) {
        targetPath = arg;
      }
      continue;
    }

    if ((arg === "-name" || arg === "-iname") && i + 1 < args.length) {
      pattern = normalizeFindGlobPattern(args[++i]);
      continue;
    }
    if ((arg === "-path" || arg === "-ipath") && i + 1 < args.length) {
      pattern = normalizeFindGlobPattern(args[++i]);
      continue;
    }

    // Skip flags with arguments so their values are NOT consumed as targetPath
    if (
      arg === "-type" ||
      arg === "-maxdepth" ||
      arg === "-mindepth" ||
      arg === "-mtime" ||
      arg === "-atime" ||
      arg === "-ctime" ||
      arg === "-mmin" ||
      arg === "-amin" ||
      arg === "-cmin" ||
      arg === "-size" ||
      arg === "-perm" ||
      arg === "-user" ||
      arg === "-group"
    ) {
      if (i + 1 < args.length) i++;
      continue;
    }
  }

  return {
    type: "find",
    path: targetPath || ".",
    pattern,
  };
}

function parseFdCommand(args: string[]): ParsedSearchCommand | null {
  let pattern: string | undefined;
  let targetPath: string | undefined;
  let ext: string | undefined;

  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if ((arg === "-e" || arg === "--extension") && i + 1 < args.length) {
      ext = args[++i];
      continue;
    }
    if (arg.startsWith("--extension=")) {
      ext = arg.slice(12);
      continue;
    }

    // Skip flags with arguments so their values don't become positionals
    if (
      arg === "-t" ||
      arg === "--type" ||
      arg === "-d" ||
      arg === "--max-depth" ||
      arg === "-E" ||
      arg === "--exclude" ||
      arg === "-c" ||
      arg === "--color" ||
      arg === "-S" ||
      arg === "--size"
    ) {
      if (i + 1 < args.length) i++;
      continue;
    }

    if (arg.startsWith("-")) continue;
    positionals.push(arg);
  }

  if (positionals.length > 0) pattern = positionals.shift();
  if (positionals.length > 0) targetPath = positionals.shift();

  if (ext) {
    const extConstraint = `*.${ext.replace(/^\./, "")}`;
    pattern = pattern ? `${pattern} ${extConstraint}` : extConstraint;
  }

  return {
    type: "find",
    path: targetPath,
    pattern,
  };
}

interface PendingSearchExecution {
  command: ParsedSearchCommand;
  rawCommand: string;
  createdAt: number;
}

const pendingShellSearches = new Map<string, PendingSearchExecution>();
const PENDING_SEARCH_TTL_MS = 15 * 60 * 1000;

function prunePendingSearches(now: number): void {
  for (const [id, entry] of pendingShellSearches) {
    if (now - entry.createdAt > PENDING_SEARCH_TTL_MS) {
      pendingShellSearches.delete(id);
    }
  }
}

/**
 * Register the transparent search interceptor:
 * Catches standalone search commands executed via bash/powershell,
 * mutates the shell command to an instant no-op, and replaces the tool_result
 * with definition-ranked, token-budgeted results and an agent steering nudge.
 */
export function registerSearchInterceptor(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return;
    }

    const rawCmd =
      typeof (event.input as { command?: string })?.command === "string"
        ? (event.input as { command: string }).command.trim()
        : "";
    if (!rawCmd) return;

    const parsed = parseSearchCommand(rawCmd);
    if (!parsed) return;

    // Drop stale entries from calls that never produced a tool_result (e.g. aborted turns)
    prunePendingSearches(Date.now());

    // Track pending search keyed by toolCallId
    pendingShellSearches.set(event.toolCallId, {
      command: parsed,
      rawCommand: rawCmd,
      createdAt: Date.now(),
    });

    // Mutate shell invocation to an instant no-op (zero disk or process overhead)
    if (event.toolName === "bash") {
      (event.input as { command: string }).command = ":";
    } else {
      (event.input as { command: string }).command = "$null";
    }
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash" && event.toolName !== "powershell") {
      return;
    }

    const pending = pendingShellSearches.get(event.toolCallId);
    if (!pending) return;
    pendingShellSearches.delete(event.toolCallId);

    const cwd = process.cwd();
    const suggestedTool = pending.command.type === "grep" ? "grep" : "find";

    const steeringHeader = [
      `[Enhanced Search Interceptor]`,
      `Executed via Pi's fast enhanced search engine (intercepted: \`${pending.rawCommand}\`).`,
      `Tip: In future turns, use the built-in \`${suggestedTool}\` or \`multi_grep\` tool directly for faster in-memory execution and structured parameters.`,
      "",
    ].join("\n");

    try {
      if (pending.command.type === "grep") {
        const res = await executeGrep(
          {
            pattern: pending.command.pattern,
            path: pending.command.path,
            glob: pending.command.glob,
            ignoreCase: pending.command.ignoreCase,
            literal: pending.command.literal,
            context: pending.command.context,
            limit: pending.command.limit,
          },
          cwd
        );

        return {
          content: [{ type: "text", text: steeringHeader + res.output }],
          details: res.details,
          isError: false,
        };
      } else {
        const res = await executeFind(
          {
            pattern: pending.command.pattern,
            path: pending.command.path,
            limit: pending.command.limit,
          },
          cwd
        );

        return {
          content: [{ type: "text", text: steeringHeader + res.output }],
          details: res.details,
          isError: false,
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `${steeringHeader}[Enhanced Search Error]: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
