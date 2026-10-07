/**
 * Structured web-search query parser and lenient constraint post-filter.
 *
 * Deconstructs user/agent queries with Google-style directives (`site:`, `before:`,
 * `after:`, `-exclusions`, `"exact phrases"`, `filetype:`, `inurl:`, `intitle:`, `OR`).
 */

import type { SearchSource } from "./types.js";

export interface QueryTerm {
  text: string;
  phrase?: boolean;
  negated?: boolean;
}

export interface StructuredQuery {
  raw: string;
  text: string;
  terms: QueryTerm[];
  sites: string[];
  excludedSites: string[];
  inUrl: string[];
  excludedInUrl: string[];
  inTitle: string[];
  excludedInTitle: string[];
  filetypes: string[];
  excludedFiletypes: string[];
  after?: string;
  before?: string;
  hasDirectives: boolean;
  hasConstraints: boolean;
}

export interface QuerySyntax {
  phrases?: boolean;
  negation?: boolean;
  site?: boolean;
  filetype?: boolean;
  dateRange?: boolean;
}

export const GOOGLE_QUERY_SYNTAX: QuerySyntax = {
  phrases: true,
  negation: true,
  site: true,
  filetype: true,
  dateRange: true,
};

export function parseSearchQuery(raw: string): StructuredQuery {
  const sites: string[] = [];
  const excludedSites: string[] = [];
  const inUrl: string[] = [];
  const excludedInUrl: string[] = [];
  const inTitle: string[] = [];
  const excludedInTitle: string[] = [];
  const filetypes: string[] = [];
  const excludedFiletypes: string[] = [];
  let after: string | undefined;
  let before: string | undefined;

  const terms: QueryTerm[] = [];
  let hasDirectives = false;

  // Tokenize preserving quoted substrings. `([\w]+:(?!\/\/))` deliberately does
  // not treat a URL scheme ("https://…") as a directive so pasted URLs survive.
  const regex = /(-?)([\w]+:(?!\/\/))?(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(raw)) !== null) {
    const isNegated = match[1] === "-";
    const directive = match[2]?.toLowerCase();
    const quotedVal = match[3] ?? match[4];
    const val = quotedVal ?? match[5];

    if (!val) continue;

    if (directive) {
      hasDirectives = true;
      const cleanDir = directive.replace(":", "");
      const cleanVal = val.toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");

      if (cleanDir === "site" || cleanDir === "domain") {
        if (isNegated) excludedSites.push(cleanVal);
        else sites.push(cleanVal);
        continue;
      }

      if (cleanDir === "inurl" || cleanDir === "url") {
        if (isNegated) excludedInUrl.push(cleanVal);
        else inUrl.push(cleanVal);
        continue;
      }

      if (cleanDir === "intitle" || cleanDir === "title") {
        if (isNegated) excludedInTitle.push(cleanVal);
        else inTitle.push(cleanVal);
        continue;
      }

      if (cleanDir === "filetype" || cleanDir === "ext") {
        const ext = cleanVal.replace(/^\./, "");
        if (isNegated) excludedFiletypes.push(ext);
        else filetypes.push(ext);
        continue;
      }

      if (cleanDir === "after" || cleanDir === "since") {
        after = val;
        continue;
      }

      if (cleanDir === "before" || cleanDir === "until") {
        before = val;
        continue;
      }

      // Unrecognized directive (e.g. "time:12:30"): keep the whole token as a
      // plain search term instead of silently dropping the directive prefix.
      terms.push({ text: isNegated ? match[0].slice(1) : match[0], negated: isNegated });
      continue;
    }

    if (quotedVal !== undefined) {
      terms.push({ text: quotedVal, phrase: true, negated: isNegated });
    } else if (isNegated) {
      terms.push({ text: val, negated: true });
    } else {
      terms.push({ text: val });
    }
  }

  const freeTerms = terms.filter((t) => !t.negated).map((t) => (t.phrase ? `"${t.text}"` : t.text));
  const text = freeTerms.join(" ");

  const hasConstraints =
    sites.length > 0 ||
    excludedSites.length > 0 ||
    inUrl.length > 0 ||
    excludedInUrl.length > 0 ||
    inTitle.length > 0 ||
    excludedInTitle.length > 0 ||
    filetypes.length > 0 ||
    excludedFiletypes.length > 0 ||
    after !== undefined ||
    before !== undefined;

  return {
    raw,
    text: text || raw,
    terms,
    sites,
    excludedSites,
    inUrl,
    excludedInUrl,
    inTitle,
    excludedInTitle,
    filetypes,
    excludedFiletypes,
    after,
    before,
    hasDirectives: hasDirectives || terms.some((t) => t.negated || t.phrase),
    hasConstraints,
  };
}

/**
 * Re-emits parsed query according to target engine capabilities.
 */
export function formatQuery(parsed: StructuredQuery, syntax: QuerySyntax): string {
  const parts: string[] = [];

  for (const term of parsed.terms) {
    if (term.negated) {
      if (syntax.negation) parts.push(`-${term.text}`);
    } else if (term.phrase) {
      parts.push(syntax.phrases ? `"${term.text}"` : term.text);
    } else {
      parts.push(term.text);
    }
  }

  if (syntax.site) {
    for (const s of parsed.sites) parts.push(`site:${s}`);
    for (const s of parsed.excludedSites) parts.push(`-site:${s}`);
  }

  if (syntax.filetype) {
    for (const f of parsed.filetypes) parts.push(`filetype:${f}`);
    for (const f of parsed.excludedFiletypes) parts.push(`-filetype:${f}`);
  }

  if (syntax.dateRange) {
    if (parsed.after) parts.push(`after:${parsed.after}`);
    if (parsed.before) parts.push(`before:${parsed.before}`);
  }

  const result = parts.join(" ").trim();
  return result || parsed.raw;
}

/**
 * Leniently post-filters results.
 * If any constraint eliminates 100% of results, drops that constraint and reports it in dropped.
 */
export function applyQueryConstraints(
  sources: SearchSource[],
  query: StructuredQuery
): { sources: SearchSource[]; dropped: string[] } {
  if (!query.hasConstraints || sources.length === 0) {
    return { sources, dropped: [] };
  }

  let current = sources;
  const dropped: string[] = [];

  // 1. Site inclusion filter
  if (query.sites.length > 0) {
    const filtered = current.filter((s) => {
      try {
        const host = new URL(s.url).hostname.toLowerCase();
        return query.sites.some((site) => host === site || host.endsWith(`.${site}`));
      } catch {
        return false;
      }
    });
    if (filtered.length > 0) {
      current = filtered;
    } else {
      dropped.push(`site:${query.sites.join(",")}`);
    }
  }

  // 2. Site exclusion filter
  if (query.excludedSites.length > 0) {
    const filtered = current.filter((s) => {
      try {
        const host = new URL(s.url).hostname.toLowerCase();
        return !query.excludedSites.some((site) => host === site || host.endsWith(`.${site}`));
      } catch {
        return true;
      }
    });
    if (filtered.length > 0) {
      current = filtered;
    } else {
      dropped.push(`-site:${query.excludedSites.join(",")}`);
    }
  }

  // 3. URL substring filters
  if (query.inUrl.length > 0) {
    const filtered = current.filter((s) => {
      const lower = s.url.toLowerCase();
      return query.inUrl.every((u) => lower.includes(u));
    });
    if (filtered.length > 0) {
      current = filtered;
    } else {
      dropped.push(`inurl:${query.inUrl.join(",")}`);
    }
  }

  // 4. Title substring filters
  if (query.inTitle.length > 0) {
    const filtered = current.filter((s) => {
      const lower = s.title.toLowerCase();
      return query.inTitle.every((t) => lower.includes(t));
    });
    if (filtered.length > 0) {
      current = filtered;
    } else {
      dropped.push(`intitle:${query.inTitle.join(",")}`);
    }
  }

  return { sources: current, dropped };
}
