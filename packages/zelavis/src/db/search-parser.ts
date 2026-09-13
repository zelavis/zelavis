import { Effect } from "effect";
import type { JsonObject } from "./json.js";
import type { Analyzer } from "./documents.js";
import type { StoreError } from "./errors.js";
import { type Query, and, or, term, termPrefixQuery } from "./query.js";

/**
 * Damerau-Levenshtein edit distance: insertions, deletions, substitutions, and transpositions.
 */
export const damerauLevenshtein = (a: string, b: string, maxDist = 2): number => {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > maxDist) return Infinity;

  const d: number[][] = [];
  for (let i = 0; i <= la; i++) d[i] = [i];
  for (let j = 0; j <= lb; j++) d[0]![j] = j;

  for (let i = 1; i <= la; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let val = Math.min(
        d[i - 1]![j]! + 1, // deletion
        d[i]![j - 1]! + 1, // insertion
        d[i - 1]![j - 1]! + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        val = Math.min(val, d[i - 2]![j - 2]! + 1); // transposition
      }
      d[i]![j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDist) return Infinity;
  }
  return d[la]![lb]!;
};

export const countPhraseMatches = (
  tokens: ReadonlyArray<string>,
  phrase: ReadonlyArray<string>,
): number => {
  if (tokens.length < phrase.length || phrase.length === 0) return 0;
  let count = 0;
  for (let i = 0; i <= tokens.length - phrase.length; i++) {
    let match = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      count += 1;
      i += phrase.length - 1;
    }
  }
  return count;
};

export interface TermClause {
  readonly kind: "term";
  readonly field?: string;
  readonly raw: string;
  readonly token: string;
}

export interface PrefixClause {
  readonly kind: "prefix";
  readonly field?: string;
  readonly raw: string;
  readonly prefix: string;
}

export interface FuzzyClause {
  readonly kind: "fuzzy";
  readonly field?: string;
  readonly raw: string;
  readonly token: string;
  readonly distance: number;
}

export interface PhraseClause {
  readonly kind: "phrase";
  readonly field?: string;
  readonly raw: string;
  readonly tokens: ReadonlyArray<string>;
}

export interface AndClause {
  readonly kind: "and";
  readonly clauses: ReadonlyArray<SearchClause>;
}

export interface OrClause {
  readonly kind: "or";
  readonly clauses: ReadonlyArray<SearchClause>;
}

export interface NotClause {
  readonly kind: "not";
  readonly clause: SearchClause;
}

export type SearchClause =
  | TermClause
  | PrefixClause
  | FuzzyClause
  | PhraseClause
  | AndClause
  | OrClause
  | NotClause;

export interface ScoredSearchTerm {
  readonly field?: string;
  readonly token: string;
  readonly raw: string;
  readonly kind: "exact" | "prefix" | "fuzzy";
  readonly fuzzyDistance?: number;
}

export interface ScoredSearchPhrase {
  readonly field?: string;
  readonly tokens: ReadonlyArray<string>;
}

export interface ParsedSearchQuery {
  readonly root: SearchClause;
  readonly terms: ReadonlyArray<ScoredSearchTerm>;
  readonly phrases: ReadonlyArray<ReadonlyArray<string>>;
  readonly scoredPhrases: ReadonlyArray<ScoredSearchPhrase>;
  readonly hasNegativesOrFieldRestrictions: boolean;
}

type Token =
  | { type: "LPAREN" }
  | { type: "RPAREN" }
  | { type: "AND" }
  | { type: "OR" }
  | { type: "NOT" }
  | { type: "FIELD"; name: string }
  | { type: "PHRASE"; text: string }
  | { type: "TERM"; text: string };

const tokenizeSearchQuery = (text: string): Token[] => {
  const tokens: Token[] = [];
  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "LPAREN" });
      i++;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "RPAREN" });
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      const start = i;
      while (i < len && text[i] !== quote) {
        if (text[i] === "\\" && i + 1 < len) i++;
        i++;
      }
      tokens.push({ type: "PHRASE", text: text.slice(start, i) });
      if (i < len && text[i] === quote) i++;
      continue;
    }

    // Check for negation prefixes: '-' or '!'
    if (ch === "!" || ch === "-") {
      tokens.push({ type: "NOT" });
      i++;
      continue;
    }

    if (ch === "+") {
      i++;
      continue;
    }

    // Check for logical symbols && and ||
    if (ch === "&" && i + 1 < len && text[i + 1] === "&") {
      tokens.push({ type: "AND" });
      i += 2;
      continue;
    }
    if (ch === "|" && i + 1 < len && text[i + 1] === "|") {
      tokens.push({ type: "OR" });
      i += 2;
      continue;
    }

    // Scan an unquoted word or field:word
    const start = i;
    while (i < len && !/\s/.test(text[i]!) && text[i] !== "(" && text[i] !== ")" && text[i] !== '"' && text[i] !== "'") {
      i++;
    }
    const rawWord = text.slice(start, i);

    // Check for field prefix: field:value or field:"phrase" or field:(...)
    const colonIdx = rawWord.indexOf(":");
    if (colonIdx > 0 && /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(rawWord.slice(0, colonIdx))) {
      const fieldName = rawWord.slice(0, colonIdx);
      const rest = rawWord.slice(colonIdx + 1);
      tokens.push({ type: "FIELD", name: fieldName });
      if (rest.length > 0) {
        if (rest.startsWith('"') || rest.startsWith("'")) {
          i = start + colonIdx + 1;
        } else {
          tokens.push({ type: "TERM", text: rest });
        }
      }
      continue;
    }

    // Check keywords
    const upper = rawWord.toUpperCase();
    if (upper === "AND") {
      tokens.push({ type: "AND" });
    } else if (upper === "OR") {
      tokens.push({ type: "OR" });
    } else if (upper === "NOT") {
      tokens.push({ type: "NOT" });
    } else {
      tokens.push({ type: "TERM", text: rawWord });
    }
  }

  return tokens;
};

export const parseSearchQuery = (
  text: string,
  analyzer: Analyzer,
  tokenize: (t: string, a: Analyzer) => Array<string>,
  options?: { fuzzy?: boolean | number; prefix?: boolean },
): ParsedSearchQuery | undefined => {
  const tokens = tokenizeSearchQuery(text);
  if (tokens.length === 0) return undefined;

  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  const parseOr = (inheritedField?: string): SearchClause | undefined => {
    let left = parseAnd(inheritedField);

    while (pos < tokens.length) {
      const token = peek();
      if (token && token.type === "OR") {
        next(); // consume OR
        const right = parseAnd(inheritedField);
        if (right !== undefined) {
          if (left === undefined) {
            left = right;
          } else {
            left = {
              kind: "or",
              clauses: left.kind === "or" ? [...left.clauses, right] : [left, right],
            };
          }
        }
      } else {
        break;
      }
    }

    return left;
  };

  const parseAnd = (inheritedField?: string): SearchClause | undefined => {
    let left = parseNot(inheritedField);

    while (pos < tokens.length) {
      const token = peek();
      if (!token || token.type === "OR" || token.type === "RPAREN") {
        break;
      }

      if (token.type === "AND") {
        next(); // consume AND
      }

      const right = parseNot(inheritedField);
      if (right !== undefined) {
        if (left === undefined) {
          left = right;
        } else {
          left = {
            kind: "and",
            clauses: left.kind === "and" ? [...left.clauses, right] : [left, right],
          };
        }
      }
    }

    return left;
  };

  const parseNot = (inheritedField?: string): SearchClause | undefined => {
    const token = peek();
    if (token && token.type === "NOT") {
      next(); // consume NOT
      const clause = parsePrimary(inheritedField);
      if (clause === undefined) return undefined;
      return { kind: "not", clause };
    }
    return parsePrimary(inheritedField);
  };

  const parsePrimary = (inheritedField?: string): SearchClause | undefined => {
    const token = next();
    if (!token) return undefined;

    if (token.type === "FIELD") {
      const field = token.name;
      const nextTok = peek();
      if (nextTok && nextTok.type === "LPAREN") {
        next(); // consume LPAREN
        const inside = parseOr(field);
        if (peek()?.type === "RPAREN") next(); // consume RPAREN
        return inside;
      }
      return parsePrimary(field);
    }

    if (token.type === "LPAREN") {
      const inside = parseOr(inheritedField);
      if (peek()?.type === "RPAREN") next(); // consume RPAREN
      return inside;
    }

    if (token.type === "PHRASE") {
      const phraseTokens = tokenize(token.text, analyzer);
      if (phraseTokens.length === 0) return undefined;
      if (phraseTokens.length === 1) {
        return {
          kind: "term",
          field: inheritedField,
          raw: token.text,
          token: phraseTokens[0]!,
        };
      }
      return {
        kind: "phrase",
        field: inheritedField,
        raw: token.text,
        tokens: phraseTokens,
      };
    }

    if (token.type === "TERM") {
      const raw = token.text;
      const isPrefixSyntax = raw.endsWith("*") && raw.length > 1;
      const fuzzyMatch = /(?:~(\d*))$/.exec(raw);
      const isFuzzySyntax = fuzzyMatch !== null && raw.length > 1;

      if (isPrefixSyntax) {
        const base = raw.slice(0, -1);
        const folded = analyzer.fold === false ? base.normalize("NFC") : base.normalize("NFC").toLowerCase();
        return {
          kind: "prefix",
          field: inheritedField,
          raw,
          prefix: folded,
        };
      }

      if (isFuzzySyntax) {
        const base = raw.slice(0, -fuzzyMatch[0].length);
        const explicitDist = fuzzyMatch[1] ? Number.parseInt(fuzzyMatch[1], 10) : undefined;
        const distance = explicitDist !== undefined && !Number.isNaN(explicitDist)
          ? explicitDist
          : (base.length <= 5 ? 1 : 2);
        const termTokens = tokenize(base, analyzer);
        const termToken = termTokens[0] ?? (analyzer.fold === false ? base : base.toLowerCase());
        return {
          kind: "fuzzy",
          field: inheritedField,
          raw,
          token: termToken,
          distance,
        };
      }

      if (options?.prefix === true) {
        const folded = analyzer.fold === false ? raw.normalize("NFC") : raw.normalize("NFC").toLowerCase();
        return {
          kind: "prefix",
          field: inheritedField,
          raw,
          prefix: folded,
        };
      }

      if (options?.fuzzy !== undefined && options.fuzzy !== false) {
        const distance = typeof options.fuzzy === "number"
          ? options.fuzzy
          : (raw.length <= 5 ? 1 : 2);
        const termTokens = tokenize(raw, analyzer);
        const termToken = termTokens[0] ?? (analyzer.fold === false ? raw : raw.toLowerCase());
        return {
          kind: "fuzzy",
          field: inheritedField,
          raw,
          token: termToken,
          distance,
        };
      }

      const termTokens = tokenize(raw, analyzer);
      if (termTokens.length === 0) return undefined;
      if (termTokens.length === 1) {
        return {
          kind: "term",
          field: inheritedField,
          raw,
          token: termTokens[0]!,
        };
      }
      return {
        kind: "and",
        clauses: termTokens.map((t) => ({
          kind: "term" as const,
          field: inheritedField,
          raw,
          token: t,
        })),
      };
    }

    return undefined;
  };

  const root = parseOr();
  if (root === undefined) return undefined;

  const terms: ScoredSearchTerm[] = [];
  const phrases: Array<ReadonlyArray<string>> = [];
  const scoredPhrases: ScoredSearchPhrase[] = [];
  let hasNegativesOrFieldRestrictions = false;

  const collect = (clause: SearchClause, insideNot = false): void => {
    if ("field" in clause && clause.field !== undefined) {
      hasNegativesOrFieldRestrictions = true;
    }
    switch (clause.kind) {
      case "term":
        if (!insideNot) {
          terms.push({
            field: clause.field,
            token: clause.token,
            raw: clause.raw,
            kind: "exact",
          });
        }
        break;
      case "prefix":
        if (!insideNot) {
          terms.push({
            field: clause.field,
            token: clause.prefix,
            raw: clause.raw,
            kind: "prefix",
          });
        }
        break;
      case "fuzzy":
        if (!insideNot) {
          terms.push({
            field: clause.field,
            token: clause.token,
            raw: clause.raw,
            kind: "fuzzy",
            fuzzyDistance: clause.distance,
          });
        }
        break;
      case "phrase":
        if (!insideNot) {
          phrases.push(clause.tokens);
          scoredPhrases.push({ field: clause.field, tokens: clause.tokens });
          for (const t of clause.tokens) {
            terms.push({
              field: clause.field,
              token: t,
              raw: t,
              kind: "exact",
            });
          }
        }
        break;
      case "and":
      case "or":
        for (const sub of clause.clauses) collect(sub, insideNot);
        break;
      case "not":
        hasNegativesOrFieldRestrictions = true;
        collect(clause.clause, true);
        break;
    }
  };

  collect(root);

  return {
    root,
    terms,
    phrases,
    scoredPhrases,
    hasNegativesOrFieldRestrictions,
  };
};

export const toPlanQuery = (
  clause: SearchClause,
  analyzer: Analyzer,
  termsOf: (field: string) => Effect.Effect<ReadonlyArray<string>, StoreError>,
): Effect.Effect<Query | undefined, StoreError> =>
  Effect.gen(function* () {
    switch (clause.kind) {
      case "term": {
        const fields = clause.field ? [clause.field] : analyzer.fields;
        const sub = fields.map((f) => term(f, clause.token));
        return sub.length === 1 ? sub[0] : or(...sub);
      }
      case "prefix": {
        const fields = clause.field ? [clause.field] : analyzer.fields;
        const sub = fields.map((f) => termPrefixQuery(f, clause.prefix));
        return sub.length === 1 ? sub[0] : or(...sub);
      }
      case "fuzzy": {
        const fields = clause.field ? [clause.field] : analyzer.fields;
        const subClauses: Query[] = [];
        for (const f of fields) {
          const stored = yield* termsOf(f);
          const matched = stored.filter((st) => damerauLevenshtein(st, clause.token, clause.distance) <= clause.distance);
          if (matched.length > 0) {
            const fieldSubs = matched.map((w) => term(f, w));
            subClauses.push(fieldSubs.length === 1 ? fieldSubs[0]! : or(...fieldSubs));
          }
        }
        if (subClauses.length === 0) return undefined;
        return subClauses.length === 1 ? subClauses[0] : or(...subClauses);
      }
      case "phrase": {
        const fields = clause.field ? [clause.field] : analyzer.fields;
        const subClauses: Query[] = [];
        for (const f of fields) {
          const fieldTerms = clause.tokens.map((t) => term(f, t));
          subClauses.push(fieldTerms.length === 1 ? fieldTerms[0]! : and(...fieldTerms));
        }
        if (subClauses.length === 0) return undefined;
        return subClauses.length === 1 ? subClauses[0] : or(...subClauses);
      }
      case "and": {
        const queries: Query[] = [];
        for (const c of clause.clauses) {
          if (c.kind === "not") continue;
          const q = yield* toPlanQuery(c, analyzer, termsOf);
          if (q !== undefined) queries.push(q);
        }
        if (queries.length === 0) return undefined;
        return queries.length === 1 ? queries[0] : and(...queries);
      }
      case "or": {
        const queries: Query[] = [];
        for (const c of clause.clauses) {
          if (c.kind === "not") return undefined;
          const q = yield* toPlanQuery(c, analyzer, termsOf);
          if (q === undefined) return undefined;
          queries.push(q);
        }
        if (queries.length === 0) return undefined;
        return queries.length === 1 ? queries[0] : or(...queries);
      }
      case "not":
        return undefined;
    }
  });

export const matchesSearchClause = (
  data: JsonObject,
  clause: SearchClause,
  analyzer: Analyzer,
  tokenize: (text: string, analyzer: Analyzer) => Array<string>,
  readPath: (data: JsonObject, path: string) => unknown,
): boolean => {
  switch (clause.kind) {
    case "term": {
      const fields = clause.field ? [clause.field] : analyzer.fields;
      for (const f of fields) {
        const val = readPath(data, f);
        if (typeof val !== "string") continue;
        const tokens = tokenize(val, analyzer);
        if (tokens.includes(clause.token)) return true;
      }
      return false;
    }
    case "prefix": {
      const fields = clause.field ? [clause.field] : analyzer.fields;
      for (const f of fields) {
        const val = readPath(data, f);
        if (typeof val !== "string") continue;
        const tokens = tokenize(val, analyzer);
        if (tokens.some((t) => t.startsWith(clause.prefix))) return true;
      }
      return false;
    }
    case "fuzzy": {
      const fields = clause.field ? [clause.field] : analyzer.fields;
      for (const f of fields) {
        const val = readPath(data, f);
        if (typeof val !== "string") continue;
        const tokens = tokenize(val, analyzer);
        if (tokens.some((t) => damerauLevenshtein(t, clause.token, clause.distance) <= clause.distance)) {
          return true;
        }
      }
      return false;
    }
    case "phrase": {
      const fields = clause.field ? [clause.field] : analyzer.fields;
      for (const f of fields) {
        const val = readPath(data, f);
        if (typeof val !== "string") continue;
        const tokens = tokenize(val, analyzer);
        if (countPhraseMatches(tokens, clause.tokens) > 0) return true;
      }
      return false;
    }
    case "and":
      return clause.clauses.every((c) => matchesSearchClause(data, c, analyzer, tokenize, readPath));
    case "or":
      return clause.clauses.some((c) => matchesSearchClause(data, c, analyzer, tokenize, readPath));
    case "not":
      return !matchesSearchClause(data, clause.clause, analyzer, tokenize, readPath);
  }
};
