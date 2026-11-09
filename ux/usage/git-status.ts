import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

export interface GitStatus {
  branch: string;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  ahead: number;
  behind: number;
}

/** Parse NUL-delimited porcelain v2; paths may contain spaces, newlines, or status-like text. */
export function parseGitStatus(output: string): GitStatus {
  const status: GitStatus = {
    branch: "", staged: 0, unstaged: 0, untracked: 0, conflicts: 0, ahead: 0, behind: 0,
  };
  let oid = "";
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# branch.head ")) status.branch = record.slice(14);
    else if (record.startsWith("# branch.oid ")) oid = record.slice(13);
    else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        status.ahead = Number(match[1]);
        status.behind = Number(match[2]);
      }
    } else if (record.startsWith("? ")) status.untracked++;
    else if (record.startsWith("u ")) status.conflicts++;
    else if (record.startsWith("1 ") || record.startsWith("2 ")) {
      const xy = record.slice(2, 4);
      if (xy[0] !== ".") status.staged++;
      if (xy[1] !== ".") status.unstaged++;
      // Rename/copy entries have a second NUL-delimited path, not another status record.
      if (record.startsWith("2 ")) i++;
    }
  }
  if (status.branch === "(detached)") status.branch = `@${oid.slice(0, 7)}`;
  return status;
}

/** File counts, not line counts. A partially staged file appears in both + and ~. */
export function formatGitStatus(
  status: GitStatus | undefined,
  fallbackBranch: string | null,
  theme: ExtensionContext["ui"]["theme"],
): string {
  if (!status) return fallbackBranch ? theme.fg("dim", ` (${fallbackBranch})`) : "";
  const parts: string[] = [];
  if (status.conflicts) parts.push(`!${status.conflicts}`);
  if (status.staged) parts.push(`+${status.staged}`);
  if (status.unstaged) parts.push(`~${status.unstaged}`);
  if (status.untracked) parts.push(`?${status.untracked}`);
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);
  const summary = parts.length ? ` ${parts.join(" ")}` : "";
  return theme.fg("dim", ` (${status.branch}${summary})`);
}

/** Reject failed, timed-out, or oversized output instead of reporting partial counts. */
export async function readGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatus> {
  const { stdout } = await execFileAsync("git", [
    "--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z",
    "--untracked-files=all", "--ignore-submodules=none",
  ], { cwd, timeout: 3000, maxBuffer: 2 * 1024 * 1024, signal });
  return parseGitStatus(stdout);
}

/** Session/footer-scoped, asynchronous cache. Never run Git from render(). */
export class GitStatusMonitor {
  status: GitStatus | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private readonly controller = new AbortController();
  private running = false;
  private pending = false;

  constructor(
    private readonly cwd: string,
    private readonly onChange: () => void,
    private readonly readStatus = readGitStatus,
  ) {}

  start(): void {
    if (this.pollTimer || this.controller.signal.aborted) return;
    this.refresh();
    // Also detect changes made in an external editor or terminal while Pi is idle.
    this.pollTimer = setInterval(() => this.refresh(), 5000);
    this.pollTimer.unref();
  }

  scheduleRefresh(): void {
    if (this.debounceTimer || this.controller.signal.aborted) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.refresh();
    }, 250);
    this.debounceTimer.unref();
  }

  refresh(): void {
    if (this.controller.signal.aborted) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    void this.load();
  }

  private async load(): Promise<void> {
    this.running = true;
    let next: GitStatus | undefined;
    try {
      next = await this.readStatus(this.cwd, this.controller.signal);
    } catch {
      // Not a repository, missing Git, or a transient failure: omit the summary.
    } finally {
      this.running = false;
    }
    if (this.controller.signal.aborted) return;
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next;
      this.onChange();
    }
    if (this.pending) {
      this.pending = false;
      this.scheduleRefresh();
    }
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.debounceTimer);
    this.pollTimer = this.debounceTimer = undefined;
    this.controller.abort();
  }
}
