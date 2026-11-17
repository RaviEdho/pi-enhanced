import type { ParsedOutput, ParserResult } from "../types.js";

export function filterSystemCommand(command: string, raw: string, isError: boolean): ParserResult {
  if (isError) return null;

  // curl / wget (word boundaries that exclude hyphenated names like "curl-loader")
  if (/(?<![\w-])(?:curl|wget)(?![\w-])/.test(command)) {
    return filterDownloadCommand(raw);
  }

  // ls / tree / find — hyphen/suffix-safe so "npm run find-assets" doesn't match
  if (/(?<![\w-])(?:ls|tree|find)(?![\w-])/.test(command)) {
    return filterFileListing(command, raw);
  }

  // docker ps / podman ps
  if (/(?<![\w-])(?:docker|podman)\s+ps(?![\w-])/.test(command)) {
    return filterDockerPs(raw);
  }

  return null;
}

function filterDownloadCommand(raw: string): ParsedOutput {
  const lines = raw.split("\n");
  // Percent signs, ETA text and runs of '=' are valid response data. Only
  // discard recognizable meter framing/rows, never arbitrary response lines.
  const filtered = lines.filter((line) => {
    const t = line.trim();
    return !(/^% Total\s+% Received\s+% Xferd/.test(t) ||
      /^Dload\s+Upload\s+Total\s+Spent\s+Left\s+Speed$/.test(t) ||
      /^\d{1,3}\s+\S+\s+\d{1,3}\s+\S+\s+\d{1,3}\s+\S+\s+\S+\s+\S+\s+(?:\d+:\d+:\d+|--:--:--)\s+(?:\d+:\d+:\d+|--:--:--)\s+(?:\d+:\d+:\d+|--:--:--)\s+\S+$/.test(t) ||
      /^\d+[KMG]\s+[.=>\s]+\d+%\s+\S+\s+\S+$/.test(t));
  });

  return { text: filtered.join("\n").trim(), lossy: false };
}

function filterFileListing(command: string, raw: string): ParsedOutput {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 40) return { text: raw, lossy: false };

  // If huge output (> 40 items), show first 30 and summarize the rest
  const head = lines.slice(0, 30);
  const remaining = lines.length - 30;
  return {
    text: [...head, `... and ${remaining} more items (total ${lines.length})`].join("\n"),
    lossy: true,
  };
}

function filterDockerPs(raw: string): ParsedOutput {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 1) {
    return { text: "No running containers", lossy: false };
  }

  // Keep first line (header) and up to 15 containers
  const containers = lines.slice(1, 16);
  const summary: string[] = ["CONTAINER ID   IMAGE   STATUS   PORTS   NAMES"];

  for (const c of containers) {
    // Collapse multi-space gaps to cleaner columns
    const normalized = c.replace(/\s{2,}/g, "  |  ");
    summary.push(normalized);
  }

  const isLossy = lines.length > 16;
  if (isLossy) {
    summary.push(`... and ${lines.length - 16} more containers`);
  }

  return { text: summary.join("\n"), lossy: isLossy };
}
