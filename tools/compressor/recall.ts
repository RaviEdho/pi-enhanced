import { randomBytes } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RecallEntry } from "./types.js";

export class RecallStore {
  private static instance: RecallStore;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, RecallEntry>();
  private readonly insertionOrder: string[] = [];

  constructor(maxEntries = 100) {
    this.maxEntries = maxEntries;
  }

  public static getInstance(): RecallStore {
    if (!RecallStore.instance) {
      RecallStore.instance = new RecallStore();
    }
    return RecallStore.instance;
  }

  public save(command: string, rawText: string, filteredText: string, savedBytes: number): string {
    const id = randomBytes(4).toString("hex");
    const entry: RecallEntry = {
      id,
      command,
      rawText,
      filteredText,
      savedBytes,
      timestamp: Date.now(),
    };

    // Save to temp file if large (> 4KB) for external viewing
    if (rawText.length > 4096) {
      try {
        const filePath = join(tmpdir(), `pi-recall-${id}.log`);
        writeFileSync(filePath, rawText, "utf8");
        entry.filePath = filePath;
      } catch {
        // Temp file creation failure is non-fatal
      }
    }

    if (this.insertionOrder.length >= this.maxEntries) {
      const oldestId = this.insertionOrder.shift();
      if (oldestId) {
        this.removeEntry(oldestId);
      }
    }

    this.insertionOrder.push(id);
    this.entries.set(id, entry);
    return id;
  }

  private removeEntry(id: string): void {
    const removed = this.entries.get(id);
    this.entries.delete(id);
    if (removed?.filePath) {
      try {
        rmSync(removed.filePath, { force: true });
      } catch {
        // Temp file cleanup failure is non-fatal
      }
    }
  }

  public get(id: string): RecallEntry | undefined {
    return this.entries.get(id);
  }

  public list(limit = 10): RecallEntry[] {
    const count = Math.min(limit, this.insertionOrder.length);
    const recentIds = this.insertionOrder.slice(-count).reverse();
    return recentIds
      .map((id) => this.entries.get(id))
      .filter((e): e is RecallEntry => e !== undefined);
  }

  public clear(): void {
    for (const id of this.entries.keys()) {
      this.removeEntry(id);
    }
    this.insertionOrder.length = 0;
  }
}
