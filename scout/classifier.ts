/**
 * Fast definition and import classifier for source code lines.
 * Helps prioritize actual code definitions over import boilerplate and usages.
 */

// Patterns indicating a definition
const DEF_PATTERNS = [
  // TypeScript / JavaScript
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?interface\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/,
  /^(?:export\s+)?enum\s+([A-Za-z0-9_$]+)/,
  /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*[:=]/,
  /^\s*(?:public|private|protected|static|readonly|async)?\s*(?:get|set)?\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*[:{]/,

  // Python
  /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/,
  /^class\s+([A-Za-z0-9_]+)(?:\s*\([^)]*\))?\s*:/,

  // Rust
  /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/,
  /^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|union)\s+([A-Za-z0-9_]+)/,
  /^impl(?:\s+<[^>]+>)?\s+(?:[A-Za-z0-9_:]+\s+for\s+)?([A-Za-z0-9_:]+)/,

  // Go
  /^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\(/,
  /^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/,

  // C / C++ / Java / C#
  /^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|struct|interface|enum)\s+([A-Za-z0-9_]+)/,
];

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
}

export function classifyLine(line: string): LineClassification {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
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
      return {
        isDefinition: true,
        isImport: false,
        definedSymbol: match[1],
      };
    }
  }

  return { isDefinition: false, isImport: false };
}
