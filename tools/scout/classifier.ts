/**
 * Fast definition and import classifier for source code lines.
 * Helps prioritize actual code definitions over import boilerplate and usages.
 */

// Patterns indicating a definition
const DEF_PATTERNS = [
  // TypeScript / JavaScript
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^export\s+\*\s+as\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/,
  /^(?:export\s+)?enum\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[:=]/,
  /^\s*(?:(?:public|private|protected|static|readonly|async)\s+)*(?:(?:get|set)\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/,

  // Python
  /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/,
  /^class\s+([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*:/,

  // Rust
  /^(?:pub(?:\([^)]+\))?\s+)?(?:(?:async|unsafe|const|default|extern(?:\s+"[^"]*")?)\s+)*fn\s+(r#[A-Za-z0-9_]+|[A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]+\))?\s+)?(?:(?:unsafe|auto|const)\s+)*(?:struct|enum|trait|union|mod|type)\s+(r#[A-Za-z0-9_]+|[A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]+\))?\s+)?(?:const|static(?:\s+mut)?)\s+([A-Za-z0-9_]+)\s*[:=]/,
  /^macro_rules!\s+([A-Za-z0-9_]+)/,

  // Go
  /^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\(/,
  /^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/,
  /^(?:const|var)\s+([A-Za-z0-9_]+)\s*=/,

  // C / C++ / Java / C#
  /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|struct|interface|enum)\s+([A-Za-z0-9_]+)/,
  /^#define\s+([A-Za-z0-9_]+)/,
];

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "catch",
  "switch",
  "with",
  "return",
  "throw",
  "else",
  "finally",
]);

// Patterns indicating imports or inclusions
const IMPORT_PATTERNS = [
  /^(?:import|from)\s+/,
  /^#include\s+/,
  /^use\s+/,
  /^\s*require\s*\(/,
  /^(?:const|let|var)\s+.*=\s*require\s*\(/,
];

export interface LineClassification {
  isDefinition: boolean;
  isImport: boolean;
  definedSymbol?: string;
  symbolStart?: number;
  symbolEnd?: number;
}

export interface ClassificationMatch {
  start: number;
  end: number;
  /** Fuzzy matches must lie entirely inside the declared symbol. */
  ranges?: Array<[number, number]>;
}

export function classifyLine(line: string, matched?: ClassificationMatch): LineClassification {
  const leading = line.length - line.trimStart().length;
  const attributes = line.trimStart().match(/^(?:#\[[^\]]*\]\s*)+/)?.[0].length ?? 0;
  const trimmed = line.trimStart().slice(attributes).trimEnd();
  const baseOffset = leading + attributes;
  if (
    !trimmed ||
    trimmed.startsWith("//") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*") ||
    (trimmed.startsWith("#") && !trimmed.startsWith("#include") && !trimmed.startsWith("#define"))
  ) {
    return { isDefinition: false, isImport: false };
  }

  // Check imports first
  for (const pat of IMPORT_PATTERNS) {
    if (pat.test(trimmed)) {
      return { isDefinition: false, isImport: true };
    }
  }

  // Check definitions
  for (const pat of DEF_PATTERNS) {
    const match = trimmed.match(pat);
    if (match) {
      const symbol = match[1];
      if (symbol && CONTROL_KEYWORDS.has(symbol)) {
        continue;
      }
      const start = baseOffset + match[0].lastIndexOf(symbol);
      const end = start + symbol.length;
      const isDefinition = !matched || (matched.ranges
        ? matched.ranges.length > 0 && matched.ranges.every(([a, b]) => a >= start && b <= end && b > a)
        : matched.end > matched.start && matched.start < end && matched.end > start);
      return { isDefinition, isImport: false, definedSymbol: symbol, symbolStart: start, symbolEnd: end };
    }
  }

  return { isDefinition: false, isImport: false };
}
