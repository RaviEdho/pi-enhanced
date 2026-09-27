import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { classifyLine } from "./classifier.js";
import { FrecencyTracker } from "./frecency.js";
import { fuzzyMatch, matchesConstraints, parseQueryConstraints } from "./matcher.js";
import type { GitFileStatus, IndexedFile, SearchMatch, SearchQueryConstraints } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "coverage",
]);

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".mp4",
  ".mp3",
  ".wav",
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".lock",
]);

export class FileIndexer {
  private static instance: FileIndexer | null = null;
  private cwd: string;
  private files: Map<string, IndexedFile> = new Map();
  private gitStatuses: Map<string, GitFileStatus> = new Map();
  private frecency = FrecencyTracker.getInstance();
  private isScanning = false;
  private lastScanTime = 0;
  private scanWaiters: Array<() => void> = [];

  private constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
  }

  public static getInstance(cwd?: string): FileIndexer {
    const resolvedCwd = cwd || process.cwd();
    if (!FileIndexer.instance || FileIndexer.instance.cwd !== resolvedCwd) {
      FileIndexer.instance = new FileIndexer(resolvedCwd);
    }
    return FileIndexer.instance;
  }

  public getCwd(): string {
    return this.cwd;
  }

  public getIndexedFileCount(): number {
    return this.files.size;
  }

  public getGitModifiedCount(): number {
    let count = 0;
    for (const f of this.files.values()) {
      if (f.gitStatus) count++;
    }
    return count;
  }

  /**
   * Refresh git status asynchronously
   */
  public async refreshGitStatus(): Promise<void> {
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
        cwd: this.cwd,
        timeout: 5000,
        maxBuffer: 5 * 1024 * 1024,
      });

      this.gitStatuses.clear();
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line || line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        let filePath = line.slice(3).trim();
        if (filePath.includes(" -> ")) {
          filePath = filePath.split(" -> ")[1].trim();
        }
        filePath = filePath.replace(/\\/g, "/");

        let status: GitFileStatus | undefined;
        if (x === "?" && y === "?") {
          status = "untracked";
        } else if (x === "M" || y === "M") {
          status = "modified";
        } else if (x === "A" || y === "A") {
          status = "staged";
        } else if (x === "D" || y === "D") {
          status = "deleted";
        }

        if (status) {
          this.gitStatuses.set(filePath, status);
        }
      }

      // Update existing files
      for (const [relPath, file] of this.files) {
        file.gitStatus = this.gitStatuses.get(relPath);
        file.frecencyScore = this.frecency.calculateScore(relPath, file.gitStatus);
      }
    } catch {
      // Non-fatal if git is not available or not a git repo
    }
  }

  /**
   * Rescan working directory
   */
  public async scan(force = false): Promise<void> {
    const now = Date.now();
    if (!force && this.files.size > 0 && now - this.lastScanTime < 10000) {
      return;
    }

    if (this.isScanning) {
      return new Promise<void>((resolve) => {
        this.scanWaiters.push(resolve);
      });
    }

    this.isScanning = true;
    try {
      await this.refreshGitStatus();

      const newFiles = new Map<string, IndexedFile>();
      await this.walkDir(this.cwd, "", newFiles);

      this.files = newFiles;
      this.lastScanTime = Date.now();
    } finally {
      this.isScanning = false;
      const waiters = this.scanWaiters;
      this.scanWaiters = [];
      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  private async walkDir(
    currentDir: string,
    relDir: string,
    collector: Map<string, IndexedFile>,
    depth = 0
  ): Promise<void> {
    if (depth > 15) return; // Prevent infinite recursion

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      if (name.startsWith(".") && name !== ".env" && name !== ".github") {
        if (name === ".git") continue;
      }
      if (DEFAULT_IGNORED_DIRS.has(name)) {
        continue;
      }

      const relPath = relDir ? `${relDir}/${name}` : name;
      const fullPath = path.join(currentDir, name);

      if (entry.isDirectory()) {
        await this.walkDir(fullPath, relPath, collector, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(name).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) {
          continue;
        }

        try {
          const stats = await fs.promises.stat(fullPath);
          if (stats.size > 2 * 1024 * 1024) {
            // Skip oversized files (>2MB)
            continue;
          }

          const gitStatus = this.gitStatuses.get(relPath);
          const frecencyScore = this.frecency.calculateScore(relPath, gitStatus);

          collector.set(relPath, {
            relativePath: relPath,
            absolutePath: fullPath,
            size: stats.size,
            mtime: stats.mtimeMs,
            gitStatus,
            frecencyScore,
          });
        } catch {
          // Stat failed, skip
        }
      }
    }
  }

  /**
   * Helper to build clean constraints from explicit path and glob options
   */
  public buildPathAndGlobConstraints(pathOpt?: string, globOpt?: string): SearchQueryConstraints {
    const constraints: SearchQueryConstraints = { pattern: "" };

    if (pathOpt && pathOpt !== ".") {
      let p = pathOpt.trim().replace(/\\/g, "/");
      if (path.isAbsolute(p)) {
        p = path.relative(this.cwd, p).replace(/\\/g, "/");
      }
      p = p.replace(/^\.\//, "");
      if (p && p !== ".") {
        constraints.includePaths = [p];
      }
    }

    if (globOpt) {
      if (!constraints.extensions) constraints.extensions = [];
      if (globOpt.startsWith("*.")) {
        constraints.extensions.push(globOpt.slice(1).toLowerCase());
      }
    }

    return constraints;
  }

  /**
   * Search files by path (fuzzy matching + constraints + frecency ranking)
   */
  public async findFiles(
    query: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ files: IndexedFile[]; totalMatched: number }> {
    await this.scan();

    const constraints = parseQueryConstraints(query);
    const pattern = constraints.pattern;
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const scored: Array<{ file: IndexedFile; score: number }> = [];

    for (const file of this.files.values()) {
      if (!matchesConstraints(file.relativePath, constraints, file.gitStatus)) {
        continue;
      }

      let matchScore = 0;
      if (pattern) {
        const match = fuzzyMatch(pattern, file.relativePath);
        if (!match) continue;
        matchScore = match.score;
      } else {
        matchScore = 50; // Base score if no pattern (list files matching constraints)
      }

      // Combine fuzzy match score with frecency score
      const totalScore = matchScore + file.frecencyScore;
      scored.push({ file, score: totalScore });
    }

    // Sort by descending score
    scored.sort((a, b) => b.score - a.score);

    const totalMatched = scored.length;
    const paginated = scored.slice(offset, offset + limit).map((s) => s.file);

    return { files: paginated, totalMatched };
  }

  /**
   * Search file contents (plain, regex, or fuzzy with smart case and definition classification)
   */
  public async grep(
    pattern: string,
    options?: {
      path?: string;
      glob?: string;
      ignoreCase?: boolean;
      literal?: boolean;
      context?: number;
      limit?: number;
      offset?: number;
      enableFuzzyFallback?: boolean;
    }
  ): Promise<{ matches: SearchMatch[]; totalMatched: number; filesSearched: number }> {
    await this.scan();

    const limit = options?.limit ?? 40;
    const offset = options?.offset ?? 0;
    const contextLines = options?.context ?? 0;
    const constraints = this.buildPathAndGlobConstraints(options?.path, options?.glob);

    // Smart case: if pattern is all lower case, default to case-insensitive
    const isAllLower = pattern.toLowerCase() === pattern;
    const caseSensitive = options?.ignoreCase === false ? true : options?.ignoreCase ? false : !isAllLower;

    let regex: RegExp | null = null;
    if (!options?.literal) {
      try {
        regex = new RegExp(pattern, caseSensitive ? "g" : "gi");
      } catch {
        // Fallback to literal if invalid regex
      }
    }

    const matches: SearchMatch[] = [];
    let filesSearched = 0;

    // Filter candidate files
    const candidateFiles: IndexedFile[] = [];
    for (const file of this.files.values()) {
      if (matchesConstraints(file.relativePath, constraints, file.gitStatus)) {
        candidateFiles.push(file);
      }
    }

    // Sort candidates so frecent and git-modified files are searched first
    candidateFiles.sort((a, b) => b.frecencyScore - a.frecencyScore);

    for (const file of candidateFiles) {
      filesSearched++;
      let content: string;
      try {
        content = await fs.promises.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let isMatch = false;
        let matchStart = -1;
        let matchEnd = -1;

        if (regex) {
          regex.lastIndex = 0;
          const m = regex.exec(line);
          if (m) {
            isMatch = true;
            matchStart = m.index;
            matchEnd = m.index + m[0].length;
          }
        } else {
          const haystack = caseSensitive ? line : line.toLowerCase();
          const needle = caseSensitive ? pattern : pattern.toLowerCase();
          const idx = haystack.indexOf(needle);
          if (idx !== -1) {
            isMatch = true;
            matchStart = idx;
            matchEnd = idx + pattern.length;
          }
        }

        if (isMatch) {
          const { isDefinition, isImport } = classifyLine(line);

          // Collect context lines
          let contextBefore: string[] | undefined;
          let contextAfter: string[] | undefined;
          if (contextLines > 0) {
            const startBefore = Math.max(0, i - contextLines);
            contextBefore = lines.slice(startBefore, i);
            const endAfter = Math.min(lines.length, i + 1 + contextLines);
            contextAfter = lines.slice(i + 1, endAfter);
          }

          matches.push({
            filePath: file.relativePath,
            lineNumber: i + 1,
            lineContent: line,
            isDefinition,
            isImport,
            matchStart,
            matchEnd,
            contextBefore,
            contextAfter,
          });

          // Early break if matches exceeded max scan capacity
          if (matches.length >= 300) break;
        }
      }

      if (matches.length >= 300) break;
    }

    // Fuzzy fallback: if exact/regex search produced zero hits, try fuzzy match on lines
    if (matches.length === 0 && options?.enableFuzzyFallback !== false && pattern.length >= 3) {
      for (const file of candidateFiles.slice(0, 50)) {
        let content: string;
        try {
          content = await fs.promises.readFile(file.absolutePath, "utf-8");
        } catch {
          continue;
        }

        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const fuzzyRes = fuzzyMatch(pattern, line);
          if (fuzzyRes && fuzzyRes.score >= 50 && fuzzyRes.matchRanges.length > 0) {
            const { isDefinition, isImport } = classifyLine(line);
            matches.push({
              filePath: file.relativePath,
              lineNumber: i + 1,
              lineContent: line,
              isDefinition,
              isImport,
              matchStart: fuzzyRes.matchRanges[0][0],
              matchEnd: fuzzyRes.matchRanges[0][1],
            });
            if (matches.length >= 100) break;
          }
        }
        if (matches.length >= 100) break;
      }
    }

    // Sort matches: definitions first, then usages, then imports
    matches.sort((a, b) => {
      if (a.isDefinition && !b.isDefinition) return -1;
      if (!a.isDefinition && b.isDefinition) return 1;
      if (a.isImport && !b.isImport) return 1;
      if (!a.isImport && b.isImport) return -1;
      return 0;
    });

    const totalMatched = matches.length;
    const paginated = matches.slice(offset, offset + limit);

    return { matches: paginated, totalMatched, filesSearched };
  }

  /**
   * Search multiple patterns at once with OR logic
   */
  public async multiGrep(
    patterns: string[],
    options?: {
      path?: string;
      glob?: string;
      ignoreCase?: boolean;
      context?: number;
      limit?: number;
    }
  ): Promise<{ matches: SearchMatch[]; totalMatched: number; filesSearched: number }> {
    await this.scan();

    const limit = options?.limit ?? 50;
    const contextLines = options?.context ?? 0;
    const constraints = this.buildPathAndGlobConstraints(options?.path, options?.glob);

    const candidateFiles: IndexedFile[] = [];
    for (const file of this.files.values()) {
      if (matchesConstraints(file.relativePath, constraints, file.gitStatus)) {
        candidateFiles.push(file);
      }
    }
    candidateFiles.sort((a, b) => b.frecencyScore - a.frecencyScore);

    const matches: SearchMatch[] = [];
    let filesSearched = 0;

    for (const file of candidateFiles) {
      filesSearched++;
      let content: string;
      try {
        content = await fs.promises.readFile(file.absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        for (const pattern of patterns) {
          const haystack = options?.ignoreCase ? line.toLowerCase() : line;
          const needle = options?.ignoreCase ? pattern.toLowerCase() : pattern;
          const idx = haystack.indexOf(needle);
          if (idx !== -1) {
            const { isDefinition, isImport } = classifyLine(line);
            let contextBefore: string[] | undefined;
            let contextAfter: string[] | undefined;
            if (contextLines > 0) {
              const startBefore = Math.max(0, i - contextLines);
              contextBefore = lines.slice(startBefore, i);
              const endAfter = Math.min(lines.length, i + 1 + contextLines);
              contextAfter = lines.slice(i + 1, endAfter);
            }

            matches.push({
              filePath: file.relativePath,
              lineNumber: i + 1,
              lineContent: line,
              isDefinition,
              isImport,
              matchStart: idx,
              matchEnd: idx + pattern.length,
              contextBefore,
              contextAfter,
              pattern,
            });
            break; // Matched at least one pattern for this line
          }
        }

        if (matches.length >= 250) break;
      }
      if (matches.length >= 250) break;
    }

    matches.sort((a, b) => {
      if (a.isDefinition && !b.isDefinition) return -1;
      if (!a.isDefinition && b.isDefinition) return 1;
      return 0;
    });

    const totalMatched = matches.length;
    return { matches: matches.slice(0, limit), totalMatched, filesSearched };
  }
}
