import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { classifyLine } from "./classifier.js";
import { FileContentCache, type FileContent } from "./content-cache.js";
import { FrecencyTracker } from "./frecency.js";
import { fuzzyMatch, matchesConstraints, parseQueryConstraints } from "./matcher.js";
import type { GitFileStatus, IndexedFile, SearchMatch, SearchQueryConstraints } from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_REFRESH_INTERVAL_MS = 10_000;
const DIRECTORY_VERIFY_INTERVAL_MS = 10_000;
const READ_CONCURRENCY = 8;

interface DirectorySnapshot {
  checkedAt: number;
  signature: string;
  entries: fs.Dirent[];
}

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
  // Images
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".tiff",
  ".tif",
  ".avif",
  ".heic",
  ".heif",
  ".psd",
  // Documents & Media
  ".pdf",
  ".mp4",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".aac",
  ".m4a",
  ".webm",
  ".avi",
  ".mov",
  ".mkv",
  // Fonts
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  // Archives
  ".zip",
  ".tar",
  ".gz",
  ".7z",
  ".bz2",
  ".xz",
  ".rar",
  ".zst",
  ".tgz",
  // Binaries, Executables & Bytecode
  ".wasm",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".bin",
  ".iso",
  ".dmg",
  ".class",
  ".pyc",
  ".pyo",
  ".o",
  ".obj",
  ".lib",
  ".a",
  ".lockb",
]);

export class FileIndexer {
  private static instance: FileIndexer | null = null;
  private cwd: string;
  private files: Map<string, IndexedFile> = new Map();
  private gitStatuses: Map<string, GitFileStatus> = new Map();
  private deletedPaths: Set<string> = new Set();
  private frecency = FrecencyTracker.getInstance();
  private directories = new Map<string, DirectorySnapshot>();
  private contentCache = new FileContentCache();
  private scanPromise?: Promise<void>;
  private lastGitRefreshTime = -Infinity;

  private constructor(cwd?: string) {
    this.cwd = cwd || process.cwd();
  }

  public static getInstance(cwd?: string): FileIndexer {
    const resolvedCwd = cwd || process.cwd();
    if (!FileIndexer.instance || FileIndexer.instance.cwd !== resolvedCwd) {
      FileIndexer.disposeIfInitialized();
      FileIndexer.instance = new FileIndexer(resolvedCwd);
    }
    return FileIndexer.instance;
  }

  public static disposeIfInitialized(): void {
    const current = FileIndexer.instance;
    FileIndexer.instance = null;
    current?.contentCache.clear();
    current?.directories.clear();
    current?.files.clear();
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
    this.lastGitRefreshTime = performance.now();
    try {
      const { stdout } = await execFileAsync("git", ["status", "--porcelain", "-uall"], {
        cwd: this.cwd,
        timeout: 5000,
        maxBuffer: 5 * 1024 * 1024,
      });

      this.gitStatuses.clear();
      this.deletedPaths.clear();
      const lines = stdout.split("\n");
      for (const line of lines) {
        if (!line || line.length < 4) continue;
        const x = line[0];
        const y = line[1];
        let filePath = line.slice(3).trim();
        if (filePath.startsWith('"') && filePath.endsWith('"')) {
          filePath = filePath.slice(1, -1);
        }
        if (filePath.includes(" -> ")) {
          filePath = filePath.split(" -> ")[1].trim();
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.slice(1, -1);
          }
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
          if (status === "deleted") {
            this.deletedPaths.add(filePath);
          }
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

  /** Check directory membership on demand; only changed listings are reread. */
  public async scan(force = false): Promise<void> {
    if (this.scanPromise) {
      await this.scanPromise;
      // An explicit rescan must not be satisfied by an in-flight incremental scan.
      if (force) await this.scan(true);
      return;
    }
    const pending = this.updateIndex(force);
    this.scanPromise = pending;
    try {
      await pending;
    } finally {
      if (this.scanPromise === pending) this.scanPromise = undefined;
    }
  }

  private async updateIndex(force: boolean): Promise<void> {
    if (force) {
      this.directories.clear();
      this.contentCache.clear();
    }
    if (force || performance.now() - this.lastGitRefreshTime >= GIT_REFRESH_INTERVAL_MS) {
      await this.refreshGitStatus();
    }
    const directoryStats = new Map<string, fs.Stats | undefined>();
    if (!force) {
      const known = [...this.directories.keys()];
      for (let i = 0; i < known.length; i += READ_CONCURRENCY) {
        await Promise.all(known.slice(i, i + READ_CONCURRENCY).map(async (dir) => {
          try {
            directoryStats.set(dir, dir === "" ? await fs.promises.stat(this.cwd)
              : await fs.promises.lstat(path.join(this.cwd, dir)));
          } catch {
            directoryStats.set(dir, undefined);
          }
        }));
      }
    }
    const newFiles = new Map<string, IndexedFile>();
    const visited = new Set<string>();
    await this.walkDir(this.cwd, "", newFiles, visited, directoryStats, force);
    this.files = newFiles;
    for (const dir of this.directories.keys()) {
      if (!visited.has(dir)) this.directories.delete(dir);
    }
    this.contentCache.retain(new Set([...newFiles.values()].map((file) => file.absolutePath)));
  }

  private async walkDir(
    currentDir: string,
    relDir: string,
    collector: Map<string, IndexedFile>,
    visited: Set<string>,
    directoryStats: ReadonlyMap<string, fs.Stats | undefined>,
    force: boolean,
    depth = 0
  ): Promise<void> {
    if (depth > 15) return;
    let snapshot = this.directories.get(relDir);
    try {
      // Permit an explicitly selected symlink workspace, but never follow child links.
      const stat = directoryStats.has(relDir) ? directoryStats.get(relDir)
        : depth === 0 ? await fs.promises.stat(currentDir) : await fs.promises.lstat(currentDir);
      if (!stat?.isDirectory()) return;
      visited.add(relDir);
      const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      if (force || snapshot?.signature !== signature ||
        performance.now() - snapshot.checkedAt >= DIRECTORY_VERIFY_INTERVAL_MS) {
        const entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
        // Keep the pre-read fingerprint: a concurrent membership change forces
        // another listing on the next search rather than caching a missed entry.
        // Periodic listing audits cover coarse/stale filesystem timestamps,
        // without restatting every unchanged file as the old full scan did.
        snapshot = { signature, entries, checkedAt: performance.now() };
        this.directories.set(relDir, snapshot);
      }
    } catch {
      return;
    }
    if (!snapshot) return;
    for (const entry of snapshot.entries) {
      const name = entry.name;
      if (DEFAULT_IGNORED_DIRS.has(name)) continue;
      if (entry.isDirectory() && name.startsWith(".") && name !== ".github") continue;
      if (entry.isFile() && name === ".DS_Store") continue;
      const relPath = relDir ? `${relDir}/${name}` : name;
      const fullPath = path.join(currentDir, name);
      if (entry.isDirectory()) {
        await this.walkDir(fullPath, relPath, collector, visited, directoryStats, force, depth + 1);
      } else if (entry.isFile()) {
        let file = !force ? this.files.get(relPath) : undefined;
        if (!file) {
          try {
            const stat = await fs.promises.lstat(fullPath);
            if (!stat.isFile()) continue;
            file = {
              relativePath: relPath, absolutePath: fullPath, size: stat.size, mtime: stat.mtimeMs,
              frecencyScore: 0, isBinary: BINARY_EXTENSIONS.has(path.extname(name).toLowerCase()),
            };
          } catch {
            continue;
          }
        }
        file.gitStatus = this.gitStatuses.get(relPath);
        file.frecencyScore = this.frecency.calculateScore(relPath, file.gitStatus);
        collector.set(relPath, file);
      }
    }
  }

  private async *readCandidates(files: readonly IndexedFile[]): AsyncGenerator<{ file: IndexedFile; content: FileContent }> {
    // Bounded I/O, but consume in the original rank order so limits/pagination
    // and definition-first matching remain deterministic.
    for (let offset = 0; offset < files.length; offset += READ_CONCURRENCY) {
      const batch = files.slice(offset, offset + READ_CONCURRENCY);
      const contents = await Promise.all(batch.map((file) => this.contentCache.read(file.absolutePath)));
      for (let i = 0; i < batch.length; i++) {
        const file = batch[i];
        const content = contents[i];
        if (content.metadata) {
          file.size = content.metadata.size;
          file.mtime = content.metadata.mtimeMs;
          file.isBinary = content.binary;
        }
        yield { file, content };
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
      const trimmed = globOpt.trim();
      if (trimmed) {
        constraints.globs = [trimmed];
      }
    }

    return constraints;
  }

  /**
   * Search files by path (fuzzy matching + constraints + frecency ranking)
   */
  public async findFiles(
    query: string,
    options?: { limit?: number; offset?: number; path?: string }
  ): Promise<{ files: IndexedFile[]; totalMatched: number }> {
    const constraints = parseQueryConstraints(query);
    await this.scan();
    // Explicit Git filters should reflect staging/deletion changes immediately.
    if (constraints.gitFilter) await this.refreshGitStatus();
    if (options?.path && options.path !== "." && options.path !== "./") {
      let p = options.path.trim().replace(/\\/g, "/");
      if (path.isAbsolute(p)) {
        p = path.relative(this.cwd, p).replace(/\\/g, "/");
      }
      p = p.replace(/^\.\//, "");
      if (p.endsWith("/")) p = p.slice(0, -1);
      if (p && p !== ".") {
        constraints.includePaths = constraints.includePaths || [];
        if (!constraints.includePaths.includes(p)) {
          constraints.includePaths.push(p);
        }
      }
    }

    const pattern = constraints.pattern;
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const scored: Array<{ file: IndexedFile; score: number }> = [];

    const considerFile = (file: IndexedFile) => {
      if (!matchesConstraints(file.relativePath, constraints, file.gitStatus)) {
        return;
      }

      let matchScore = 0;
      if (pattern) {
        const match = fuzzyMatch(pattern, file.relativePath);
        if (!match) return;
        matchScore = match.score;
      } else {
        matchScore = 50; // Base score if no pattern (list files matching constraints)
      }

      // Combine fuzzy match score with frecency score
      const totalScore = matchScore + file.frecencyScore;
      scored.push({ file, score: totalScore });
    };

    for (const file of this.files.values()) {
      considerFile(file);
    }

    // Deleted-but-tracked files are not on disk and therefore not indexed by
    // walkDir; surface them as synthetic candidates so `git:deleted` queries work.
    if (constraints.gitFilter === "deleted") {
      for (const relPath of this.deletedPaths) {
        if (this.files.has(relPath)) continue;
        considerFile({
          relativePath: relPath,
          absolutePath: path.join(this.cwd, relPath),
          size: 0,
          mtime: 0,
          gitStatus: "deleted",
          frecencyScore: 0,
        });
      }
    }

    // Sort by descending score
    scored.sort((a, b) => b.score - a.score);

    const totalMatched = scored.length;
    const paginated = scored.slice(offset, offset + limit).map((s) => s.file);
    // Only returned paths need fresh metadata; do not stat every indexed file.
    for (let i = 0; i < paginated.length; i += READ_CONCURRENCY) {
      await Promise.all(paginated.slice(i, i + READ_CONCURRENCY).map(async (file) => {
        if (!this.files.has(file.relativePath)) return; // Synthetic git:deleted entry.
        try {
          const stat = await fs.promises.lstat(file.absolutePath);
          if (!stat.isFile()) return;
          if (file.size !== stat.size || file.mtime !== stat.mtimeMs) {
            file.isBinary = BINARY_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase());
          }
          file.size = stat.size;
          file.mtime = stat.mtimeMs;
        } catch { /* The path may disappear after the membership snapshot. */ }
      }));
    }
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
    const literalNeedle = caseSensitive ? pattern : pattern.toLowerCase();

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

    // Known binary extensions never enter content search. Other binary/size
    // decisions are revalidated on use so an edited file can become searchable.
    const candidateFiles: IndexedFile[] = [];
    for (const file of this.files.values()) {
      if (BINARY_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase())) continue;
      if (matchesConstraints(file.relativePath, constraints, file.gitStatus)) {
        candidateFiles.push(file);
      }
    }

    // Sort candidates so frecent and git-modified files are searched first
    candidateFiles.sort((a, b) => b.frecencyScore - a.frecencyScore);

    for await (const { file, content } of this.readCandidates(candidateFiles)) {
      if (content.searched) filesSearched++;
      const lines = content.lines;
      if (!lines) continue;
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
          const idx = haystack.indexOf(literalNeedle);
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
      for await (const { file, content } of this.readCandidates(candidateFiles.slice(0, 50))) {
        const lines = content.lines;
        if (!lines) continue;
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
      offset?: number;
    }
  ): Promise<{ matches: SearchMatch[]; totalMatched: number; filesSearched: number }> {
    await this.scan();

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;
    const contextLines = options?.context ?? 0;
    const constraints = this.buildPathAndGlobConstraints(options?.path, options?.glob);
    const needles = patterns.map((pattern) => {
      const ignoreCase = options?.ignoreCase ?? (pattern.toLowerCase() === pattern);
      return { pattern, ignoreCase, needle: ignoreCase ? pattern.toLowerCase() : pattern };
    });

    const candidateFiles: IndexedFile[] = [];
    for (const file of this.files.values()) {
      if (BINARY_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase())) continue;
      if (matchesConstraints(file.relativePath, constraints, file.gitStatus)) {
        candidateFiles.push(file);
      }
    }
    candidateFiles.sort((a, b) => b.frecencyScore - a.frecencyScore);

    const matches: SearchMatch[] = [];
    let filesSearched = 0;

    for await (const { file, content } of this.readCandidates(candidateFiles)) {
      if (content.searched) filesSearched++;
      const lines = content.lines;
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let folded: string | undefined;
        for (const { pattern, ignoreCase, needle } of needles) {
          const haystack = ignoreCase ? (folded ??= line.toLowerCase()) : line;
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
      if (a.isImport && !b.isImport) return 1;
      if (!a.isImport && b.isImport) return -1;
      return 0;
    });

    const totalMatched = matches.length;
    return { matches: matches.slice(offset, offset + limit), totalMatched, filesSearched };
  }
}
