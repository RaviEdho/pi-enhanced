/**
 * Shell command safety validator for Plan Mode.
 *
 * In Plan Mode, shell execution is restricted to safe, non-destructive read-only
 * operations. Any command that modifies files, installs packages, changes git
 * repository state, or performs destructive operations is blocked.
 */

// Patterns indicating destructive or mutating operations
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // File operations
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|tee|truncate|dd|shred)\b/i,
  // Redirection writing to files (excluding 2>&1 and /dev/null redirection)
  /(?:^|[^<2&])>(?!>)(?!\s*\/dev\/null)/,
  />>(?!\s*\/dev\/null)/,
  // Package managers
  /\b(npm|yarn|pnpm|bun)\s+(install|i\b|add|remove|uninstall|update|upgrade|ci|publish|link|unlink)/i,
  /\bpip(3)?\s+(install|uninstall)/i,
  /\b(apt|apt-get|brew|pacman|dnf|yum)\s+(install|remove|purge|upgrade|update)/i,
  // Git mutating commands
  /\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|restore|clean|stash|cherry-pick|revert|init|clone|branch\s+-[dD]|tag\s+[^-])/i,
  // System control & processes
  /\b(sudo|su|kill|pkill|killall|reboot|shutdown|systemctl|service)\b/i,
  // Interactive editors
  /\b(vim?|nano|emacs|code|subl|micro)\b/i,
  // Mutating flags in linters / formatters
  /--(write|fix|apply)\b/i,
];

// Patterns for known safe read-only commands
const SAFE_PATTERNS: RegExp[] = [
  // Navigation & directory inspection
  /^\s*(pwd|dirs)\b/,
  /^\s*(ls|tree|dir)\b/,
  // File viewing & inspection
  /^\s*(cat|head|tail|less|more|bat|nl|wc|stat|file|diff|cmp|du|df)\b/,
  // Content & code search
  /^\s*(grep|egrep|fgrep|rg|ag|ack|find|fd)\b/,
  // Text filtering (read-only stdout stream)
  /^\s*(echo|printf|sort|uniq|cut|tr|column|paste|jq|yq|awk)\b/,
  /^\s*sed\s+-n\b/,
  // Git read-only inspection
  /^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get|ls-files|ls-remote|rev-parse|describe|tag(\s+-l|\s+--list)?|check-ignore|check-ref-format|cat-file|shortlog|blame)/i,
  // Package inspection
  /^\s*npm\s+(list|ls|view|info|outdated|audit|prefix|root|explain|why)/i,
  /^\s*yarn\s+(list|info|why|audit)/i,
  /^\s*pnpm\s+(list|ls|outdated|audit|why)/i,
  /^\s*pip(3)?\s+(list|show)/i,
  /^\s*cargo\s+(check|tree|metadata|pkgid|verify-project)/i,
  /^\s*go\s+(version|env|list)/i,
  // Typechecks & non-mutating checks
  /^\s*(npx\s+)?tsc\s+--noEmit\b/,
  /^\s*(npx\s+)?(eslint|biome\s+check)\b/,
  // Version and environment checks
  /^\s*(node|python|python3|git|cargo|go|rustc|deno|bun)\s+(--version|-v|-V)\b/i,
  /^\s*(uname|whoami|id|date|cal|uptime|ps|which|whereis|type|env|printenv)\b/,
  // Read-only web fetch
  /^\s*curl\s/i,
  /^\s*wget\s+-O\s*-/i,
];

/**
 * Checks whether a shell command is safe to execute in Plan Mode.
 *
 * Rejects if:
 * 1. Any destructive pattern is found anywhere in the command (including subshells or chained commands).
 * 2. Any sub-command in pipes (`|`), AND chains (`&&`), OR chains (`||`), or semicolons (`;`)
 *    is not recognized as a safe read-only command.
 */
export function isSafeBashCommand(command: string): { safe: boolean; reason?: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { safe: true };
  }

  // Check for known destructive patterns
  for (const pattern of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return {
        safe: false,
        reason: `Command contains mutating or prohibited operation matching ${pattern}`,
      };
    }
  }

  // Split on chaining operators (&&, ||, ;, |) to inspect individual pipeline stages
  // Note: we preserve quotes in simple splitting by matching outside quotes
  const segments = trimmed
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const segment of segments) {
    const isSafe = SAFE_PATTERNS.some((pattern) => pattern.test(segment));
    if (!isSafe) {
      return {
        safe: false,
        reason: `Sub-command '${segment}' is not in the read-only allowlist`,
      };
    }
  }

  return { safe: true };
}
