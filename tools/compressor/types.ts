export interface FilterResult {
  text: string;
  originalBytes: number;
  filteredBytes: number;
  savedBytes: number;
  filterName: string;
  lossy: boolean;
}

export interface ParsedOutput {
  text: string;
  lossy?: boolean;
}

export type ParserResult = string | ParsedOutput | null;


export interface RecallEntry {
  id: string;
  command: string;
  rawText: string;
  filteredText: string;
  savedBytes: number;
  timestamp: number;
  /** Temp file holding the raw output for large entries (cleaned up on eviction). */
  filePath?: string;
}

export interface DeclarativeRule {
  name: string;
  matchCommand: RegExp;
  stripAnsi?: boolean;
  stripLinesMatching?: RegExp[];
  keepLinesMatching?: RegExp[];
  maxLines?: number;
  onEmpty?: string;
}

export interface GainRecord {
  command: string;
  filterName: string;
  originalBytes: number;
  filteredBytes: number;
  savedBytes: number;
  timestamp: number;
}

export interface GainSummary {
  totalCommands: number;
  originalBytes: number;
  filteredBytes: number;
  savedBytes: number;
  savedTokensEst: number;
  savingsPercentage: number;
  breakdownByFilter: Record<string, { count: number; savedBytes: number; savedTokensEst: number }>;
}
