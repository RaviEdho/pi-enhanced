export type SearchMode = "tools" | "override";

export type GitFileStatus = "modified" | "staged" | "untracked" | "deleted";

export interface IndexedFile {
  /** Relative path normalized with forward slashes (e.g. "src/index.ts") */
  relativePath: string;
  /** Absolute filesystem path */
  absolutePath: string;
  /** File size in bytes */
  size: number;
  /** Last modification timestamp in ms */
  mtime: number;
  /** Git status if not clean */
  gitStatus?: GitFileStatus;
  /** Calculated frecency score */
  frecencyScore: number;
}

export interface SearchMatch {
  filePath: string;
  lineNumber: number;
  lineContent: string;
  isDefinition: boolean;
  isImport: boolean;
  matchStart: number;
  matchEnd: number;
  contextBefore?: string[];
  contextAfter?: string[];
  pattern?: string;
}

export interface FindResultItem {
  relativePath: string;
  gitStatus?: GitFileStatus;
  frecencyTag?: "hot" | "warm" | "frequent";
  score: number;
}

export interface FindResult {
  items: FindResultItem[];
  totalMatched: number;
  truncated: boolean;
  cursor?: string;
  scanDurationMs: number;
}

export interface GrepResult {
  matches: SearchMatch[];
  totalMatched: number;
  filesSearched: number;
  truncated: boolean;
  cursor?: string;
  suggestion?: string;
  scanDurationMs: number;
}

export interface SearchQueryConstraints {
  /** Cleaned text pattern without special constraint tokens */
  pattern: string;
  /** File extensions to include (e.g. [".ts", ".js"]) */
  extensions?: string[];
  /** Subpaths or directories to include */
  includePaths?: string[];
  /** Subpaths or directories to exclude */
  excludePaths?: string[];
  /** Git status filter (e.g. "modified") */
  gitFilter?: GitFileStatus;
}
