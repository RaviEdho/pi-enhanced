import fs from "node:fs";

export const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_CACHE_FILES = 4096;
// Also reread periodically: coarse/preserved timestamps must not retain stale text indefinitely.
const CONTENT_VERIFY_INTERVAL_MS = 10_000;

interface FileMetadata {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
}

export interface FileContent {
  lines?: readonly string[];
  metadata?: FileMetadata;
  binary: boolean;
  searched: boolean;
}

interface CachedContent {
  checkedAt: number;
  signature: string;
  lines?: readonly string[];
  binary: boolean;
  bytes: number;
}

function signature(stat: FileMetadata): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Bounded, memory-only LRU. Every reuse validates the file, including atomic replacements. */
export class FileContentCache {
  private entries = new Map<string, CachedContent>();
  private inFlight = new Map<string, { signature: string; promise: Promise<FileContent> }>();
  private bytes = 0;
  private generation = 0;

  clear(): void {
    this.generation++;
    this.entries.clear();
    this.inFlight.clear();
    this.bytes = 0;
  }

  forget(filePath: string): void {
    const entry = this.entries.get(filePath);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(filePath);
  }

  retain(paths: ReadonlySet<string>): void {
    for (const filePath of this.entries.keys()) {
      if (!paths.has(filePath)) this.forget(filePath);
    }
  }

  async read(filePath: string): Promise<FileContent> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(filePath);
    } catch {
      this.forget(filePath);
      return { binary: false, searched: true };
    }
    if (!stat.isFile() || stat.size > MAX_SEARCH_FILE_BYTES) {
      this.forget(filePath);
      return { metadata: stat, binary: false, searched: false };
    }
    const version = signature(stat);
    const cached = this.entries.get(filePath);
    if (cached?.signature === version && performance.now() - cached.checkedAt < CONTENT_VERIFY_INTERVAL_MS) {
      this.entries.delete(filePath);
      this.entries.set(filePath, cached);
      return { lines: cached.lines, metadata: stat, binary: cached.binary, searched: !cached.binary };
    }
    this.forget(filePath);
    const pending = this.inFlight.get(filePath);
    if (pending?.signature === version) return pending.promise;

    const promise = this.load(filePath, stat, this.generation).finally(() => {
      if (this.inFlight.get(filePath)?.promise === promise) this.inFlight.delete(filePath);
    });
    this.inFlight.set(filePath, { signature: version, promise });
    return promise;
  }

  private async load(filePath: string, initial: fs.Stats, generation: number): Promise<FileContent> {
    // Retry once if the path or file changes while it is being read. Never cache
    // a torn read, an I/O failure, a directory, or a symlink in place of a file.
    for (let attempt = 0; attempt < 2; attempt++) {
      let handle: fs.promises.FileHandle | undefined;
      try {
        const before = attempt === 0 ? initial : await fs.promises.lstat(filePath);
        if (!before.isFile() || before.size > MAX_SEARCH_FILE_BYTES) {
          return { metadata: before, binary: false, searched: false };
        }
        handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        // Read at most the validated size, then verify the descriptor and path.
        // The post-read stats detect growth/truncation without an extra EOF read.
        const buffer = Buffer.allocUnsafe(before.size);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        const after = await handle.stat();
        const current = await fs.promises.lstat(filePath);
        if (!current.isFile() || length !== before.size ||
          signature(after) !== signature(before) || signature(current) !== signature(before)) continue;
        const text = buffer.toString("utf8", 0, length);
        const binary = text.includes("\0");
        const lines = binary ? undefined : text.split(/\r?\n/);
        // Conservative accounting includes decoded text, line/string overhead and metadata.
        const bytes = (binary ? 0 : 2 * text.length + (lines?.length ?? 0) * 64) + filePath.length * 2 + 512;
        if (generation === this.generation && bytes <= MAX_CACHE_BYTES) {
          this.forget(filePath);
          while (this.entries.size >= MAX_CACHE_FILES || this.bytes + bytes > MAX_CACHE_BYTES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.forget(oldest);
          }
          this.entries.set(filePath, {
            checkedAt: performance.now(), signature: signature(after), lines, binary, bytes,
          });
          this.bytes += bytes;
        }
        return { lines, metadata: after, binary, searched: true };
      } catch {
        this.forget(filePath);
        return { binary: false, searched: true };
      } finally {
        await handle?.close().catch(() => {});
      }
    }
    return { binary: false, searched: true };
  }
}
