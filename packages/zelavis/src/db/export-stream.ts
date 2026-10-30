import { Effect, Stream } from "effect";
import type { BackupEvent } from "./backup.js";
import { InvalidExport, type DbError } from "./errors.js";
import type { DbEvent, EventCursor } from "./events.js";
import { holdLogAtCompaction } from "./log-hold.js";
import type { ObjectIdentity, Seq } from "./model.js";
import type { ObjectStoreApi, RecordState } from "./store.js";
import { isDerivedNamespace } from "./tenancy.js";
import type { TenantId } from "./topology.js";

/**
 * A Tenant read out as a stream: its records, then every change since, in pages a client asks for
 * with the cursor the last page gave.
 *
 * The records are read while writes carry on, so on their own they are not one moment. The log
 * after the point the export began is: applying every entry received by version (an entry older than
 * what is held changes nothing, a newer one brings it forward) gives the Tenant as of the last event
 * received, once that is past the log position the record scan finished at. A page says when that
 * holds (`consistent`), and it stays true from then on, because from there every page continues the
 * log in order. Each call reads a page of records and a page of the log together, so the position
 * the export follows from stays close to the head instead of leaving the whole log to be read at the end.
 *
 * Nothing is pinned between calls but the log: from the first call until the export is consistent
 * the Tenant's log is held at the position it began (`holdLog`, renewed by every call, ended by its
 * time), so upkeep cannot cut the events the export has still to follow. Once consistent the hold is
 * released and the cursor is an ordinary event cursor: a consumer that falls behind compaction gets
 * `CursorCompacted` and starts over, as with any event read.
 */
export interface ExportPage {
  readonly tenantId: TenantId;
  /** Records first, then log events; for a divided Tenant each entry names its part. */
  readonly entries: ReadonlyArray<ExportEntry>;
  /** Opaque: pass it back to read what follows. Bound to the Tenant and to its life; never a position to compare. */
  readonly cursor: string;
  /**
   * True once the entries received so far, applied by version, are the Tenant as of a single log
   * position, and from then on. For a divided Tenant, true once every part is, each as of its own.
   */
  readonly consistent: boolean;
  /** A divided Tenant's parts, in the order its cursor carries them; absent for an undivided Tenant. */
  readonly parts?: ReadonlyArray<string>;
}

export type ExportEntry = BackupEvent & { readonly part?: string };

export interface ExportPageInput {
  /** The cursor the last page gave; none starts an export. */
  readonly cursor?: string;
  /** Entries per phase per part, 1 to 1024; 256 when omitted. A page holds at most two phases' worth per part. */
  readonly limit?: number;
}

export const EXPORT_DEFAULT_LIMIT = 256;
export const EXPORT_MAX_LIMIT = 1024;
/** How long an unfinished export holds the log without a call renewing it. */
const EXPORT_HOLD_TTL_MILLIS = 5 * 60_000;
const CURSOR_LIMIT = 4096;

/** A record an export carries: named, and not state that is rebuilt rather than restored. */
export const carried = (identity: ObjectIdentity | undefined): identity is ObjectIdentity =>
  identity !== undefined && !isDerivedNamespace(identity.namespace);

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export const entryOfRecord = (seq: Seq, record: RecordState): BackupEvent | undefined =>
  !record.live || !carried(record.identity)
    ? undefined
    : {
        kind: "put",
        seq,
        version: record.version,
        at: Date.now(),
        body: toBase64(record.body),
        manifest: record.manifest,
        identity: record.identity,
      };

export const entryOfEvent = (event: DbEvent): BackupEvent | undefined => {
  if (!carried(event.identity)) return undefined;
  return event._tag === "ObjectPut"
    ? { kind: "put", seq: event.seq, version: event.version, at: event.at, body: toBase64(event.bytes), manifest: event.manifest, identity: event.identity }
    : { kind: "retract", seq: event.seq, version: event.version, at: event.at };
};

/** What a partition's cursor remembers between calls. */
interface PartitionExport {
  /** The partition and its life, so a cursor cannot continue another's. */
  readonly p: string;
  readonly i: string;
  /** The hold's name while the export is unfinished; absent once it is consistent. */
  readonly h?: string;
  /** The log position the export began at: where its hold sits. */
  readonly b: number;
  /** The last record identifier read; absent once every record was. */
  readonly a?: number;
  /** Whether every record was read. */
  readonly d: boolean;
  /** Whether the export has become consistent, which it stays. */
  readonly c: boolean;
  /** Where the log was last followed to. */
  readonly f?: string;
}

const invalid = (reason: string) => new InvalidExport({ reason });

const encode = (state: unknown): string => Buffer.from(JSON.stringify(state), "utf8").toString("base64url");

const decode = (cursor: string): Effect.Effect<unknown, InvalidExport> => {
  if (cursor.length === 0 || cursor.length > CURSOR_LIMIT) return Effect.fail(invalid("the cursor is not one an export gave"));
  try {
    return Effect.succeed(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown);
  } catch {
    return Effect.fail(invalid("the cursor is not one an export gave"));
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const partitionState = (value: unknown): Effect.Effect<PartitionExport, InvalidExport> => {
  if (!isRecord(value)) return Effect.fail(invalid("the cursor is not one an export gave"));
  const { p, i, h, b, a, d, c, f } = value;
  const count = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field >= 0;
  if (typeof p !== "string" || typeof i !== "string" || !count(b) || typeof d !== "boolean" || typeof c !== "boolean"
    || (h !== undefined && (typeof h !== "string" || h.length === 0 || h.length > 128))
    || (a !== undefined && !count(a)) || (f !== undefined && typeof f !== "string")) {
    return Effect.fail(invalid("the cursor is not one an export gave"));
  }
  return Effect.succeed({
    p, i, b: b as number, d, c,
    ...(h === undefined ? {} : { h }), ...(a === undefined ? {} : { a: a as number }), ...(f === undefined ? {} : { f }),
  });
};

export const checkedLimit = (limit: number | undefined): Effect.Effect<number, InvalidExport> =>
  limit === undefined
    ? Effect.succeed(EXPORT_DEFAULT_LIMIT)
    : Number.isSafeInteger(limit) && limit >= 1 && limit <= EXPORT_MAX_LIMIT
      ? Effect.succeed(limit)
      : Effect.fail(invalid(`limit is 1 to ${EXPORT_MAX_LIMIT}, not ${String(limit)}`));

/**
 * One call of an export of one partition: see `ExportPage`. The returned `cursor` encodes this
 * partition's state; `exportPartitionState` is the same step with the state in the open, for a
 * caller that carries several partitions' states in one cursor.
 */
export const exportPartitionPage = (
  store: ObjectStoreApi,
  input: { readonly cursor?: string; readonly limit: number },
): Effect.Effect<{ readonly entries: ReadonlyArray<BackupEvent>; readonly cursor: string; readonly consistent: boolean }, DbError | InvalidExport> =>
  Effect.gen(function* () {
    const stepped = yield* exportPartitionStep(store, input.cursor === undefined ? undefined : yield* Effect.flatMap(decode(input.cursor), partitionState), input.limit);
    return { entries: stepped.entries, cursor: encode(stepped.state), consistent: stepped.consistent };
  });

export const exportPartitionStep = (
  store: ObjectStoreApi,
  previous: PartitionExport | undefined,
  limit: number,
): Effect.Effect<{ readonly entries: ReadonlyArray<BackupEvent>; readonly state: PartitionExport; readonly consistent: boolean }, DbError | InvalidExport> =>
  Effect.gen(function* () {
    const stats = yield* store.stats;
    const life = stats.incarnation ?? "";
    let state: PartitionExport;
    if (previous === undefined) {
      const id = crypto.randomUUID();
      const held = yield* holdLogAtCompaction(store, id, EXPORT_HOLD_TTL_MILLIS);
      const mark = yield* store.events.head;
      const begun = (yield* store.stats).head;
      // Raised from the compaction point to where the export follows from: nothing before it is needed.
      if (held) yield* store.holdLog({ id, position: begun, ttlMillis: EXPORT_HOLD_TTL_MILLIS });
      state = { p: store.partition, i: life, ...(held ? { h: id } : {}), b: begun, d: false, c: false, ...(mark === undefined ? {} : { f: mark }) };
    } else {
      if (previous.p !== store.partition) return yield* invalid("the cursor belongs to another Tenant");
      if (previous.i !== life) return yield* invalid("the Tenant was removed and written again since this cursor; start the export again");
      state = previous;
      if (state.h !== undefined) {
        // Renewed by every call; a hold already lost to a pass that cut the log is found where the log is read.
        yield* store.holdLog({ id: state.h, position: state.b, ttlMillis: EXPORT_HOLD_TTL_MILLIS }).pipe(
          Effect.catchTag("LogCompacted", () => Effect.void),
        );
      }
    }

    const entries: BackupEvent[] = [];
    if (!state.d) {
      const page = yield* store.scanRecords({ ...(state.a === undefined ? {} : { after: state.a as Seq }), limit });
      for (const { seq, record } of page) {
        const entry = entryOfRecord(seq, record);
        if (entry !== undefined) entries.push(entry);
      }
      const last = page.at(-1);
      if (page.length < limit) {
        // Every record was read, so the export is consistent once the log has been read to its end after this.
        state = { ...state, d: true, ...(last === undefined ? {} : { a: last.seq }) };
      } else if (last !== undefined) {
        state = { ...state, a: last.seq };
      }
    }

    const events = [...(yield* Stream.runCollect(
      store.events.read({ ...(state.f === undefined ? {} : { after: state.f as EventCursor }), limit }),
    ))];
    for (const event of events) {
      const entry = entryOfEvent(event);
      if (entry !== undefined) entries.push(entry);
    }
    const followed = events.at(-1)?.cursor ?? state.f;
    state = { ...state, ...(followed === undefined ? {} : { f: followed }) };

    // Every record was read before the log was read to its end in this call, so the log has been followed
    // past the head the records were read at: from here the entries received are one position's state.
    if (!state.c && state.d && events.length < limit) {
      state = { ...state, c: true };
      if (state.h !== undefined) {
        yield* store.releaseLog(state.h);
        const { h: _released, ...rest } = state;
        state = rest;
      }
    }
    return { entries, state, consistent: state.c };
  });

/**
 * One call of an export of a divided Tenant: every part advances by one page of its own, and the
 * cursor carries each part's cursor under the part's name. The Tenant is consistent once every
 * part is, each as of its own position: parts are separate partitions with no common log, so there
 * is no one moment across them (see `Database.branchTenant`, which gives the same guarantee).
 */
export const exportDividedPage = (
  tenant: TenantId,
  parts: ReadonlyArray<string>,
  input: ExportPageInput,
  pageOf: (part: string, cursor: string | undefined, limit: number) => Effect.Effect<
    { readonly entries: ReadonlyArray<BackupEvent>; readonly cursor: string; readonly consistent: boolean },
    DbError | InvalidExport
  >,
): Effect.Effect<ExportPage, DbError | InvalidExport> =>
  Effect.gen(function* () {
    const limit = yield* checkedLimit(input.limit);
    let carriedOver: Record<string, string> = {};
    if (input.cursor !== undefined) {
      const value = yield* decode(input.cursor);
      const names = isRecord(value) && Array.isArray(value.parts) ? value.parts : undefined;
      const cursors = isRecord(value) && isRecord(value.c) ? value.c : undefined;
      if (names === undefined || cursors === undefined || names.length !== parts.length || names.some((name, at) => name !== parts[at])) {
        return yield* invalid(`the cursor is not one an export of "${tenant}" gave, or the Tenant is divided differently now; start the export again`);
      }
      for (const part of parts) {
        const given = cursors[part];
        if (typeof given !== "string") return yield* invalid("the cursor is missing a part");
        carriedOver[part] = given;
      }
    }
    const entries: ExportEntry[] = [];
    const next: Record<string, string> = {};
    let consistent = true;
    for (const part of parts) {
      const page = yield* pageOf(part, input.cursor === undefined ? undefined : carriedOver[part], limit);
      for (const entry of page.entries) entries.push({ ...entry, part });
      next[part] = page.cursor;
      consistent = consistent && page.consistent;
    }
    return { tenantId: tenant, entries, cursor: encode({ v: 1, parts, c: next }), consistent, parts };
  });
