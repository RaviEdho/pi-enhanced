import type { DeclarativeRule } from "./types.js";

export const DECLARATIVE_RULES: DeclarativeRule[] = [
  {
    name: "package-install",
    matchCommand: /\b(npm|pnpm|yarn|bun)\s+(install|add|i)\b/,
    stripLinesMatching: [
      /^\s*$/,
      /^(added|readded|removed|changed)\s+\d+\s+packages/i,
      /^\s*audited\s+\d+\s+packages/i,
      /^\s*found\s+\d+\s+vulnerabilities/i,
      /^\s*Progress:/i,
      /^\s*packages are looking for funding/i,
    ],
    maxLines: 15,
    onEmpty: "ok packages installed",
  },
  {
    name: "python-package-install",
    matchCommand: /\b(pip|poetry|uv)\s+(install|add|sync)\b/,
    stripLinesMatching: [
      /^\s*$/,
      /^Requirement already satisfied:/i,
      /^Using cached/i,
      /^Downloading/i,
      /^Collecting/i,
      /^Installing collected packages:/i,
    ],
    maxLines: 20,
    onEmpty: "ok packages installed",
  },
  {
    name: "brew-install",
    matchCommand: /\bbrew\s+(install|upgrade)\b/,
    stripLinesMatching: [
      /^\s*$/,
      /^==>\s+Downloading/i,
      /^==>\s+Fetching/i,
      /^Already downloaded:/i,
      /^Pouring/i,
    ],
    maxLines: 20,
    onEmpty: "ok brew packages installed",
  },
  {
    name: "terraform-plan",
    matchCommand: /\b(terraform|tofu)\s+plan\b/,
    keepLinesMatching: [
      /^Plan:/i,
      /^No changes\./i,
      /^Error:/i,
      /^\s*[~+-]\s+resource/i,
      /^\s*[~+-]\s+module/i,
    ],
    maxLines: 35,
  },
  {
    name: "pre-commit",
    matchCommand: /\bpre-commit\s+run\b/,
    stripLinesMatching: [/^\s*$/, /Passed\s*$/i],
    maxLines: 30,
    onEmpty: "✓ pre-commit: all hooks passed",
  },
  {
    name: "system-disk",
    matchCommand: /\bdf(\s+-[a-zA-Z]+)?\b/,
    stripLinesMatching: [/^\s*$/, /\/(dev|sys|run|snap|docker|overlay)/],
    maxLines: 20,
  },
];
