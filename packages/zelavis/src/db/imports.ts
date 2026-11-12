/**
 * Importing a collection's documents from another system's export.
 *
 * The formats are the ones every source can produce: CSV (Postgres and
 * Supabase `COPY … TO … CSV HEADER`, MySQL, spreadsheets), NDJSON and a JSON
 * array (Firestore and most document stores). A source is read, never
 * connected to: credentials, accounts and media are separate capabilities.
 *
 * An import is three steps, each its own call and each repeatable:
 *
 * - `plan` is the dry run. It parses every row, maps CSV text to the declared
 *   types, checks each id is present and appears once, checks each row against
 *   the collection's active schema, and, for an `insert`, that no id is held
 *   already. It writes nothing and answers the rows, the problems (the first
 *   hundred) and a SHA-256 checksum of the rows as they will be stored.
 * - `run` writes rows from `offset`, at most `limit` per call, in batches that
 *   each commit atomically with an idempotency key naming the import, the
 *   batch and the checksum. A run cut off and repeated, or repeated after it
 *   finished, writes nothing twice. A source that changed is a different
 *   checksum and so a different import: an `insert` of it refuses the ids
 *   already written rather than replacing them. It answers `next` while rows
 *   remain. The first call (offset 0) refuses a source whose plan has problems,
 *   counting a held document identical to its row as this import's own.
 * - `verify` reads every row's document back and compares it, answering what
 *   is missing or different and whether the stored rows' checksum equals the
 *   source's: the evidence a cutover waits for.
 */
import { Effect } from "effect";
import { isJsonValue, parseJson } from "../core/json-validation.js";
import type { Json as JsonValue, JsonObject } from "./json.js";
import type { DocumentsApi, DocumentWrite } from "./document-model.js";
import { InvalidImport } from "./errors.js";
import type { SchemasApi } from "./schema-activation.js";

export type ImportFormat = "csv" | "ndjson" | "json";
export type ImportFieldType = "string" | "number" | "integer" | "boolean" | "json";

export interface ImportSource {
  readonly collection: string;
  readonly format: ImportFormat;
  /** The export itself, at most 8 MiB of text. */
  readonly text: string;
  /** The field holding each row's id; `id` unless given. It becomes the document id and is not stored in its data. */
  readonly idField?: string;
  /** CSV column types; a column not named is text. JSON rows keep their own types. An empty CSV cell is absent. */
  readonly types?: Readonly<Record<string, ImportFieldType>>;
  /** `insert` (default) refuses an id the collection holds; `upsert` replaces it. */
  readonly mode?: "insert" | "upsert";
}

export interface ImportProblem {
  /** 1-based row of the source (a CSV's header is row 0). */
  readonly row: number;
  readonly id?: string;
  readonly reason: string;
}

export interface ImportPlan {
  readonly collection: string;
  readonly rows: number;
  readonly valid: boolean;
  /** The first hundred problems; `problemCount` is all of them. */
  readonly problems: ReadonlyArray<ImportProblem>;
  readonly problemCount: number;
  /** Every field a row carries, sorted. */
  readonly fields: ReadonlyArray<string>;
  /** SHA-256 of the rows as they will be stored, in source order. */
  readonly checksum: string;
}

export interface ImportRun {
  readonly collection: string;
  readonly importId: string;
  readonly offset: number;
  /** Rows this call wrote (or found already written by an earlier run of the same import). */
  readonly written: number;
  /** Where the next call starts, while rows remain. */
  readonly next?: number;
  readonly rows: number;
  readonly checksum: string;
}

export interface ImportVerification {
  readonly collection: string;
  readonly rows: number;
  readonly matched: number;
  /** The first hundred ids with no document, and with a different one. */
  readonly missing: ReadonlyArray<string>;
  readonly different: ReadonlyArray<string>;
  readonly sourceChecksum: string;
  readonly storedChecksum: string;
  readonly ok: boolean;
}

export interface ImportsApi {
  readonly plan: (source: ImportSource) => Effect.Effect<ImportPlan, InvalidImport>;
  readonly run: (source: ImportSource & { readonly importId: string; readonly offset?: number; readonly limit?: number }) => Effect.Effect<ImportRun, InvalidImport | ImportWriteError>;
  readonly verify: (source: ImportSource) => Effect.Effect<ImportVerification, InvalidImport>;
}

type ImportWriteError = Effect.Error<ReturnType<DocumentsApi["write"]>>;

const MAX_TEXT = 8 * 1024 * 1024;
const MAX_ROWS = 100_000;
const MAX_PROBLEMS = 100;
const BATCH = 250;
const MAX_RUN = 5000;
const IMPORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

interface Row { readonly row: number; readonly id: string; readonly data: JsonObject }

const refuse = (reason: string) => new InvalidImport({ reason });

/** RFC 4180: quoted fields, doubled quotes, CR LF or LF, a header row. */
const parseCsv = (text: string): string[][] => {
  const records: string[][] = [];
  let field = "", record: string[] = [], quoted = false, at = 0;
  const end = () => { record.push(field); field = ""; };
  while (at < text.length) {
    const char = text[at]!;
    if (quoted) {
      if (char === '"') {
        if (text[at + 1] === '"') { field += '"'; at += 2; continue; }
        quoted = false; at += 1; continue;
      }
      field += char; at += 1; continue;
    }
    if (char === '"' && field.length === 0) { quoted = true; at += 1; continue; }
    if (char === ",") { end(); at += 1; continue; }
    if (char === "\r" || char === "\n") {
      end(); records.push(record); record = [];
      at += char === "\r" && text[at + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char; at += 1;
  }
  if (quoted) throw refuse("the CSV ends inside a quoted field");
  if (field.length > 0 || record.length > 0) { end(); records.push(record); }
  return records.filter((entry) => !(entry.length === 1 && entry[0] === ""));
};

const typed = (value: string, type: ImportFieldType): JsonValue => {
  switch (type) {
    case "string": return value;
    case "number": {
      const number = Number(value);
      if (value.trim() === "" || !Number.isFinite(number)) throw new TypeError(`"${value}" is not a number`);
      return number;
    }
    case "integer": {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || !/^-?\d+$/.test(value.trim())) throw new TypeError(`"${value}" is not an integer`);
      return number;
    }
    case "boolean": {
      const lower = value.trim().toLowerCase();
      if (lower === "true" || lower === "t" || lower === "1") return true;
      if (lower === "false" || lower === "f" || lower === "0") return false;
      throw new TypeError(`"${value}" is not a boolean`);
    }
    case "json": return parseJson(value, isJsonValue, "a json cell");
  }
};

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** Rows as they will be stored, and the problems found on the way, in source order. */
const readRows = (source: ImportSource): { rows: Row[]; problems: ImportProblem[]; problemCount: number } => {
  if (typeof source.text !== "string" || source.text.length > MAX_TEXT) throw refuse("an import's text is at most 8 MiB");
  if (!["csv", "ndjson", "json"].includes(source.format)) throw refuse(`the format is csv, ndjson or json, not "${String(source.format)}"`);
  const idField = source.idField ?? "id";
  for (const [field, type] of Object.entries(source.types ?? {})) {
    if (!["string", "number", "integer", "boolean", "json"].includes(type)) throw refuse(`"${field}" has type "${String(type)}"; use string, number, integer, boolean or json`);
  }
  const raw: Array<{ row: number; value: unknown; error?: string }> = [];
  if (source.format === "csv") {
    const [header, ...records] = parseCsv(source.text);
    if (header === undefined) throw refuse("the CSV has no header row");
    if (new Set(header).size !== header.length) throw refuse("the CSV header names a column twice");
    for (const [index, record] of records.entries()) {
      if (record.length !== header.length) { raw.push({ row: index + 1, value: undefined, error: `has ${record.length} fields, the header ${header.length}` }); continue; }
      const value: Record<string, JsonValue> = {};
      try {
        for (const [column, name] of header.entries()) {
          const cell = record[column]!;
          if (cell === "") continue;
          value[name] = name === idField ? cell : typed(cell, source.types?.[name] ?? "string");
        }
        raw.push({ row: index + 1, value });
      } catch (cause) {
        raw.push({ row: index + 1, value: undefined, error: cause instanceof Error ? cause.message : String(cause) });
      }
    }
  } else if (source.format === "ndjson") {
    for (const [index, line] of source.text.split(/\r?\n/).entries()) {
      if (line.trim() === "") continue;
      try { raw.push({ row: index + 1, value: JSON.parse(line) }); }
      catch { raw.push({ row: index + 1, value: undefined, error: "is not JSON" }); }
    }
  } else {
    let parsed: unknown;
    try { parsed = JSON.parse(source.text); } catch { throw refuse("the text is not JSON"); }
    if (!Array.isArray(parsed)) throw refuse("a json import is an array of objects");
    for (const [index, value] of parsed.entries()) raw.push({ row: index + 1, value });
  }
  if (raw.length > MAX_ROWS) throw refuse(`an import holds at most ${MAX_ROWS} rows; split it`);
  const rows: Row[] = [];
  const problems: ImportProblem[] = [];
  let problemCount = 0;
  const problem = (entry: ImportProblem) => { problemCount += 1; if (problems.length < MAX_PROBLEMS) problems.push(entry); };
  const seen = new Set<string>();
  for (const entry of raw) {
    if (entry.error !== undefined) { problem({ row: entry.row, reason: entry.error }); continue; }
    if (!isObject(entry.value)) { problem({ row: entry.row, reason: "is not an object" }); continue; }
    const id = entry.value[idField];
    if (typeof id !== "string" && typeof id !== "number") { problem({ row: entry.row, reason: `has no "${idField}"` }); continue; }
    const key = String(id);
    if (seen.has(key)) { problem({ row: entry.row, id: key, reason: "repeats an id an earlier row has" }); continue; }
    seen.add(key);
    const { [idField]: _id, ...data } = entry.value;
    rows.push({ row: entry.row, id: key, data });
  }
  return { rows, problems, problemCount };
};

/** Keys sorted at every depth, so a checksum does not depend on field order. */
const canonical = (value: JsonValue): string =>
  Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : isObject(value) ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`).join(",")}}`
      : JSON.stringify(value);

const checksumOf = (rows: ReadonlyArray<{ readonly id: string; readonly data: JsonObject }>) => {
  const bytes = new TextEncoder().encode(rows.map((row) => `${JSON.stringify(row.id)}\t${canonical(row.data)}`).join("\n"));
  return Effect.map(Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)), (digest) =>
    [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
};

export const importsFor = (documents: DocumentsApi, schemas: SchemasApi): ImportsApi => {
  const read = (source: ImportSource) => Effect.try({
    try: () => readRows(source),
    catch: (cause) => cause instanceof InvalidImport ? cause : refuse(cause instanceof Error ? cause.message : String(cause)),
  });

  /**
   * The dry run. `resuming` is a run checking its own source: a held document identical to its row is
   * this import's own earlier write (its batch replays from its receipt), so it is not a problem.
   */
  const planOf = (source: ImportSource, resuming: boolean) =>
    Effect.gen(function* () {
      if (!(yield* documents.collectionExists(source.collection))) return yield* refuse(`there is no collection "${source.collection}"; create it, and its schema, first`);
      const mode = source.mode ?? "insert";
      if (mode !== "insert" && mode !== "upsert") return yield* refuse(`the mode is insert or upsert, not "${String(mode)}"`);
      const { rows, problems, problemCount } = yield* read(source);
      let count = problemCount;
      const add = (entry: ImportProblem) => { count += 1; if (problems.length < MAX_PROBLEMS) problems.push(entry); };
      const active = yield* schemas.getActive(source.collection);
      for (const row of rows) {
        if (active !== undefined) {
          const result = yield* schemas.validate(source.collection, row.data);
          if (!result.valid) add({ row: row.row, id: row.id, reason: result.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ") });
        }
        if (mode === "insert") {
          const held = yield* documents.findById({ collection: source.collection, id: row.id }).pipe(Effect.orElseSucceed(() => undefined));
          if (held !== undefined && !(resuming && canonical(held.data as JsonObject) === canonical(row.data))) {
            add({ row: row.row, id: row.id, reason: "is held already; import with mode upsert to replace it" });
          }
        }
      }
      const fields = [...new Set(rows.flatMap((row) => Object.keys(row.data)))].sort();
      return { collection: source.collection, rows: rows.length, valid: count === 0, problems, problemCount: count, fields, checksum: yield* checksumOf(rows) } satisfies ImportPlan;
    });
  const plan = (source: ImportSource) => planOf(source, false);

  return {
    plan,
    run: (source) =>
      Effect.gen(function* () {
        if (typeof source.importId !== "string" || !IMPORT_ID.test(source.importId)) return yield* refuse("an import id is 1 to 64 letters, digits, dots, dashes or underscores");
        const offset = source.offset ?? 0;
        const limit = source.limit ?? MAX_RUN;
        if (!Number.isSafeInteger(offset) || offset < 0) return yield* refuse("offset is a row count from 0");
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RUN) return yield* refuse(`limit is 1 to ${MAX_RUN} rows`);
        // The plan is checked on the first call only: a later call may find its own earlier rows held.
        const { rows } = yield* read(source);
        const checksum = yield* checksumOf(rows);
        if (offset === 0) {
          const checked = yield* planOf(source, true);
          if (!checked.valid) return yield* refuse(`the source has ${checked.problemCount} problems; plan it and fix them first (row ${checked.problems[0]?.row}: ${checked.problems[0]?.reason})`);
        }
        if (offset > rows.length) return yield* refuse(`offset ${offset} is past the last of ${rows.length} rows`);
        const stop = Math.min(rows.length, offset + limit);
        // Batches are aligned to the batch size from the start, so a repeated run names the same batches.
        let at = offset - (offset % BATCH);
        if (at !== offset) return yield* refuse(`offset is a multiple of ${BATCH}, the batch size, or a value a run answered as next`);
        let written = 0;
        while (at < stop) {
          const batch = rows.slice(at, Math.min(at + BATCH, rows.length));
          const operations = batch.map((row): DocumentWrite => (source.mode ?? "insert") === "upsert"
            ? { _tag: "Upsert", collection: source.collection, id: row.id, data: row.data }
            : { _tag: "Insert", collection: source.collection, id: row.id, data: row.data });
          yield* documents.write({ operations, idempotencyKey: `import:${source.importId}:${checksum.slice(0, 16)}:${at}` });
          written += batch.length;
          at += batch.length;
        }
        return {
          collection: source.collection, importId: source.importId, offset, written, rows: rows.length, checksum,
          ...(at < rows.length ? { next: at } : {}),
        } satisfies ImportRun;
      }),
    verify: (source) =>
      Effect.gen(function* () {
        const { rows } = yield* read(source);
        const stored: Array<{ readonly id: string; readonly data: JsonObject }> = [];
        const missing: string[] = [], different: string[] = [];
        let matched = 0;
        for (const row of rows) {
          const document = yield* documents.findById({ collection: source.collection, id: row.id }).pipe(Effect.orElseSucceed(() => undefined));
          if (document === undefined) { if (missing.length < MAX_PROBLEMS) missing.push(row.id); continue; }
          stored.push({ id: row.id, data: document.data as JsonObject });
          if (canonical(document.data as JsonObject) === canonical(row.data)) matched += 1;
          else if (different.length < MAX_PROBLEMS) different.push(row.id);
        }
        const sourceChecksum = yield* checksumOf(rows);
        const storedChecksum = yield* checksumOf(stored);
        return {
          collection: source.collection, rows: rows.length, matched, missing, different, sourceChecksum, storedChecksum,
          ok: matched === rows.length && sourceChecksum === storedChecksum,
        } satisfies ImportVerification;
      }),
  };
};
