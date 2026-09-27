import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { GitFileStatus } from "./types.js";

interface FrecencyEntry {
  count: number;
  lastAccess: number;
}

interface FrecencyStoreData {
  version: number;
  entries: Record<string, FrecencyEntry>;
}

export class FrecencyTracker {
  private static instance: FrecencyTracker | null = null;
  private entries = new Map<string, FrecencyEntry>();
  private storePath: string;
  private dirty = false;
  private saveTimeout: NodeJS.Timeout | null = null;

  private constructor() {
    const baseDir =
      process.env.PI_CODING_AGENT_DIR ||
      path.join(os.homedir(), ".pi", "agent");
    this.storePath = path.join(baseDir, "search-frecency.json");
    this.load();
  }

  public static getInstance(): FrecencyTracker {
    if (!FrecencyTracker.instance) {
      FrecencyTracker.instance = new FrecencyTracker();
    }
    return FrecencyTracker.instance;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, "utf-8");
        const data = JSON.parse(raw) as FrecencyStoreData;
        if (data && data.entries && typeof data.entries === "object") {
          for (const [key, entry] of Object.entries(data.entries)) {
            if (entry && typeof entry.count === "number" && typeof entry.lastAccess === "number") {
              this.entries.set(key, entry);
            }
          }
        }
      }
    } catch {
      // Non-fatal if unreadable
    }
  }

  public saveSync(): void {
    if (!this.dirty) return;
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: FrecencyStoreData = {
        version: 1,
        entries: Object.fromEntries(this.entries.entries()),
      };
      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), "utf-8");
      this.dirty = false;
    } catch {
      // Non-fatal if unable to persist
    }
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveTimeout = null;
      this.saveSync();
    }, 5000);
  }

  /**
   * Record that a file was accessed or viewed
   */
  public recordAccess(filePath: string): void {
    const norm = filePath.replace(/\\/g, "/");
    const existing = this.entries.get(norm);
    const now = Date.now();
    if (existing) {
      existing.count += 1;
      existing.lastAccess = now;
    } else {
      this.entries.set(norm, { count: 1, lastAccess: now });
    }
    this.scheduleSave();
  }

  /**
   * Calculate frecency score for a file
   */
  public calculateScore(filePath: string, gitStatus?: GitFileStatus): number {
    const norm = filePath.replace(/\\/g, "/");
    const entry = this.entries.get(norm);
    let score = 0;

    if (entry) {
      const now = Date.now();
      const ageMs = now - entry.lastAccess;
      const oneHour = 3600 * 1000;
      const oneDay = 24 * oneHour;
      const oneWeek = 7 * oneDay;

      let recencyWeight = 5;
      if (ageMs <= oneHour) {
        recencyWeight = 100;
      } else if (ageMs <= oneDay) {
        recencyWeight = 60;
      } else if (ageMs <= oneWeek) {
        recencyWeight = 25;
      }

      // Frequency factor clamped to avoid runaway scores
      const freqFactor = Math.min(entry.count, 20);
      score += recencyWeight + freqFactor * 5;
    }

    // Git status bonus: files being actively edited or staged are most likely targets
    if (gitStatus === "modified") {
      score += 75;
    } else if (gitStatus === "staged") {
      score += 65;
    } else if (gitStatus === "untracked") {
      score += 35;
    }

    return score;
  }

  public getFrecencyTag(score: number): "hot" | "warm" | "frequent" | undefined {
    if (score >= 100) return "hot";
    if (score >= 50) return "warm";
    if (score >= 15) return "frequent";
    return undefined;
  }

  public getTrackedCount(): number {
    return this.entries.size;
  }
}
