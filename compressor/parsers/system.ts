export function filterSystemCommand(command: string, raw: string, isError: boolean): string | null {
  if (isError) return null;

  // curl / wget
  if (/\b(curl|wget)\b/.test(command)) {
    return filterDownloadCommand(raw);
  }

  // ls / tree / find
  if (/\b(ls|tree|find)\b/.test(command)) {
    return filterFileListing(command, raw);
  }

  // docker ps / podman ps
  if (/\b(docker|podman)\s+ps\b/.test(command)) {
    return filterDockerPs(raw);
  }

  return null;
}

function filterDownloadCommand(raw: string): string {
  const lines = raw.split("\n");
  // Filter out download progress meters and percentages
  const filtered = lines.filter((line) => {
    const trimmed = line.trim();
    if (/%|--:--:--|[#=]{4,}|ETA\b/i.test(trimmed)) return false;
    if (trimmed.startsWith("curl:") || trimmed.startsWith("wget:")) return true;
    return true;
  });

  return filtered.join("\n").trim();
}

function filterFileListing(command: string, raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 40) return raw;

  // If huge output (> 40 items), show first 30 and summarize the rest
  const head = lines.slice(0, 30);
  const remaining = lines.length - 30;
  return [...head, `... and ${remaining} more items (total ${lines.length})`].join("\n");
}

function filterDockerPs(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= 1) {
    return "No running containers";
  }

  // Keep first line (header) and up to 15 containers
  const containers = lines.slice(1, 16);
  const summary: string[] = ["CONTAINER ID   IMAGE   STATUS   PORTS   NAMES"];

  for (const c of containers) {
    // Collapse multi-space gaps to cleaner columns
    const normalized = c.replace(/\s{2,}/g, "  |  ");
    summary.push(normalized);
  }

  if (lines.length > 16) {
    summary.push(`... and ${lines.length - 16} more containers`);
  }

  return summary.join("\n");
}
