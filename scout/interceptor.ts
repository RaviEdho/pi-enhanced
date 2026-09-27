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

/**
 * Split shell command string into tokens, preserving quoted arguments
 */
export function splitShellTokens(cmd: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escapeNext = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (escapeNext) {
      current += ch;
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (/\s/.test(ch) && !inDoubleQuote && !inSingleQuote) {
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
  return tokens;
}

/**
 * Attempt to parse a standalone shell search command (rg, grep, ag, find, fd)
 * Returns null if the command is compound, contains pipes/redirection, or cannot be parsed.
 */
export function parseSearchCommand(rawCmd: string): ParsedSearchCommand | null {
  const trimmed = rawCmd.trim();
  if (!trimmed) return null;

  // Never intercept pipelines, background jobs, redirections, or chained commands
  if (/[|&><;`\n]/.test(trimmed)) return null;

  const tokens = splitShellTokens(trimmed);
  if (tokens.length === 0) return null;

  const bin = tokens[0].toLowerCase();

  if (bin === "rg" || bin === "ripgrep") {
    return parseRgCommand(tokens.slice(1));
  }
  if (bin === "grep" || bin === "egrep") {
    return parseGrepCommand(tokens.slice(1));
  }
  if (bin === "ag") {
    return parseAgCommand(tokens.slice(1));
  }
  if (bin === "find") {
    return parseFindCommand(tokens.slice(1));
  }
  if (bin === "fd") {
    return parseFdCommand(tokens.slice(1));
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

  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

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

    // Skip other known flags like -n, -l, -u, --no-heading, etc.
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

  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-e" || arg === "--regexp") {
      if (i + 1 < args.length) pattern = args[++i];
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
    if (arg === "-C" || arg === "-A" || arg === "-B") {
      if (i + 1 < args.length) {
        const val = parseInt(args[++i], 10);
        if (!isNaN(val)) context = Math.max(context ?? 0, val);
      }
      continue;
    }
    if (arg === "-m" && i + 1 < args.length) {
      const val = parseInt(args[++i], 10);
      if (!isNaN(val)) limit = val;
      continue;
    }

    if (arg.startsWith("-") && !arg.startsWith("--")) {
      // Check combined short flags e.g. -rni, -rn, -F
      if (arg.includes("i")) ignoreCase = true;
      if (arg.includes("F")) literal = true;
      continue;
    }

    if (arg.startsWith("--")) {
      if (arg === "--ignore-case") ignoreCase = true;
      if (arg === "--fixed-strings") literal = true;
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
    if (arg === "-C" && i + 1 < args.length) {
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
  // Exact extension filter e.g. *.ts
  if (/^\*\.[a-zA-Z0-9_-]+$/.test(p)) {
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
    if (a === "-exec" || a === "-execdir" || a === "-delete" || a === "-ok") {
      return null;
    }
  }

  let targetPath: string | undefined;
  let pattern: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("-") && !targetPath) {
      targetPath = arg;
      continue;
    }
    if ((arg === "-name" || arg === "-iname") && i + 1 < args.length) {
      pattern = normalizeFindGlobPattern(args[++i]);
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
}

const pendingShellSearches = new Map<string, PendingSearchExecution>();

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

    // Track pending search keyed by toolCallId
    pendingShellSearches.set(event.toolCallId, {
      command: parsed,
      rawCommand: rawCmd,
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
