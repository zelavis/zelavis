/**
 * Scheduled, encrypted, off-site backups on a Node host: of a Project (its database, runtime store and media) or
 * of the Platform (its System Store), each a set of named components staged side by side into one run.
 *
 * A schedule names when (a cron expression, Effect's `Cron`), where (a target: an S3-compatible bucket or a
 * directory, typically another machine's mount) and how many runs to keep. A run is a database image (every
 * shard through the ordered key-value interface, as `maintenance.image` makes it) packed into one stream,
 * encrypted with AES-256-GCM in parts of at most 4 MiB, each sealed with its run and position as additional data
 * so no part can be swapped, dropped or reordered unnoticed, and written to the target as objects that are never
 * overwritten (`ifAbsent`). The run's manifest is written last: a run without one was cut off and is never offered.
 *
 * Key custody is explicit. Each schedule has its own 256-bit key, generated when it is made and answered then,
 * once, as its `recoveryKey`: the operator keeps it off the host, because a backup is only as recoverable as its
 * key. The host keeps a copy (in this module's state file, owner-only) so scheduled runs need nobody; the target
 * never holds anything readable. A schedule's target must pass `probeFileStorageGuarantees` before it is
 * accepted: a store that ignores conditional writes cannot be trusted with a commit point.
 *
 * `verify` downloads and decrypts every part of a run and checks the plaintext digest against the manifest.
 * `restore` turns a run back into an image directory on this host, which opens as a database with the engine it
 * was written in; replacing the live database with it is the operator's act with the Project stopped, as for any
 * image. Every run, verification and restore is recorded with its outcome.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Cron, Duration, Effect, FiberMap, Result, Scope, Semaphore } from "effect";
import { createLocalFileStorage } from "../adapters/_shared.js";
import { isNonNegativeInteger, isString, objectFields, parseJson } from "../core/json-validation.js";
import type { ZelavisFileStorage } from "../platform/storage-types.js";
import { createS3CompatibleFileStorage } from "../storage/s3.js";
import { probeFileStorageGuarantees } from "../storage/conditions.js";
import type { DatabaseApi } from "./database.js";
import { InvalidBackup } from "./errors.js";
import { loadSqliteOpener } from "./engines/node-sqlite.js";
import { destinationEngine } from "./node-images.js";

export type BackupTarget =
  | { readonly kind: "directory"; readonly path: string }
  | {
    readonly kind: "s3"; readonly bucket: string; readonly region: string; readonly endpoint?: string;
    readonly prefix?: string; readonly forcePathStyle?: boolean;
    readonly accessKeyId: string; readonly secretAccessKey: string;
  };

export interface BackupScheduleInput {
  readonly name: string;
  /** Five or six field cron expression, in UTC unless `timeZone` says otherwise. */
  readonly cron: string;
  readonly timeZone?: string;
  /** Runs to keep at the target, 1 to 1000; older ones are removed after each run. */
  readonly keep: number;
  readonly target: BackupTarget;
  /** Drill every scheduled run right after it is made: restored, opened, measured, removed. */
  readonly drillAfterRun?: boolean;
}

/** A schedule as answered: credentials are never answered back. */
export interface BackupSchedule extends Omit<BackupScheduleInput, "target"> {
  readonly target: { readonly kind: BackupTarget["kind"]; readonly location: string };
  readonly createdAt: string;
  /** Identifies the key without revealing it: the first 16 hex digits of its SHA-256. */
  readonly keyFingerprint: string;
  readonly nextRunAt?: string;
}

export interface BackupRun {
  readonly schedule: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly status: "running" | "ok" | "failed";
  readonly error?: string;
  readonly bytes?: number;
  readonly parts?: number;
  readonly verifiedAt?: string;
  readonly verified?: boolean;
  readonly restoredTo?: string;
  /** The last restore drill of this run: restored into a fresh directory and opened. */
  readonly drill?: BackupDrill;
}

/**
 * A restore drill: the run restored into a fresh directory and opened as it would be after losing the host.
 * `rtoMs` is how long getting it back took (download, decrypt, unpack, open); `rpoMs` how old its data was
 * when the drill ran, the most a loss at that moment would have cost.
 */
export interface BackupDrill {
  readonly at: string;
  readonly ok: boolean;
  readonly rtoMs: number;
  readonly rpoMs: number;
  /** What the restored copy held: Tenants and records for a database, records for a System Store. */
  readonly tenants?: number;
  readonly records?: number;
  /** For a managed app's run: its recipe, and the directories its data was captured from, as `stageRecipeBackup` wrote them. */
  readonly app?: { readonly recipe: string; readonly captured: ReadonlyArray<string>; readonly missing: ReadonlyArray<string> };
  readonly error?: string;
}

/** A drill of a run made by another host's schedule: what was drilled, and how it went. */
export interface ForeignDrill extends BackupDrill {
  readonly schedule: string;
  readonly runId: string;
  readonly createdAt: string;
}

interface StoredSchedule extends BackupScheduleInput { readonly createdAt: string; readonly key: string }
interface State { readonly schedules: ReadonlyArray<StoredSchedule>; readonly runs: ReadonlyArray<BackupRun> }

/**
 * One part of what a run captures: it writes its files into the directory it is handed (`<run>/<name>/`), and a
 * restore gives them back under the same name. A database image, a consistent copy of a SQLite store, a store's
 * records as JSON, a directory of media files.
 */
export interface BackupComponent {
  readonly name: string;
  readonly stage: (into: string) => Effect.Effect<void, InvalidBackup>;
}

interface Manifest {
  readonly format: "zelavis.backup.v1";
  readonly components: ReadonlyArray<string>;
  readonly schedule: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly parts: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly keyFingerprint: string;
  readonly noncePrefix: string;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PART_BYTES = 4 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const RUNS_KEPT = 200;
const STATE_FILE = "backup-state.json";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stateRecord = (value: unknown): value is State => isRecord(value) && Array.isArray(value.schedules) && Array.isArray(value.runs);
const manifestRecord = objectFields<Manifest>({
  format: (value): value is "zelavis.backup.v1" => value === "zelavis.backup.v1",
  components: (value): value is ReadonlyArray<string> => Array.isArray(value) && value.every((entry) => typeof entry === "string"),
  schedule: isString, runId: isString, createdAt: isString,
  parts: isNonNegativeInteger, bytes: isNonNegativeInteger, sha256: isString, keyFingerprint: isString, noncePrefix: isString,
});

const appSummaryRecord = objectFields<{ readonly recipe: string; readonly directories: ReadonlyArray<{ readonly name: string; readonly captured: string | null }> }>({
  recipe: isString,
  directories: (value): value is ReadonlyArray<{ readonly name: string; readonly captured: string | null }> => Array.isArray(value) && value.every((entry) =>
    isRecord(entry) && typeof entry.name === "string" && (entry.captured === null || (typeof entry.captured === "string" && !entry.captured.split("/").includes("..")))),
});

const fingerprint = (key: string) => createHash("sha256").update(Buffer.from(key, "base64url")).digest("hex").slice(0, 16);
const locationOf = (target: BackupTarget) => target.kind === "directory" ? target.path : `s3://${target.bucket}/${target.prefix ?? ""}`;

const storageOf = (target: BackupTarget): ZelavisFileStorage =>
  target.kind === "directory"
    ? createLocalFileStorage(target.path)
    : createS3CompatibleFileStorage({
      bucket: target.bucket, region: target.region, accessKeyId: target.accessKeyId, secretAccessKey: target.secretAccessKey,
      ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint }),
      ...(target.prefix === undefined ? {} : { prefix: target.prefix }),
      ...(target.forcePathStyle === undefined ? {} : { forcePathStyle: target.forcePathStyle }),
    });

const refuse = (reason: string) => new InvalidBackup({ reason });
const failed = (op: string) => (cause: unknown) => refuse(`${op}: ${cause instanceof Error ? cause.message : String(cause)}`);
const io = <A>(op: string, run: () => Promise<A> | A) => Effect.tryPromise({ try: () => Promise.resolve(run()), catch: failed(op) });

/** The 12-byte nonce of part `index`: the run's random prefix, then the index. */
const nonceOf = (prefix: Uint8Array, index: number) => {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setBigUint64(4, BigInt(index));
  return nonce;
};
const additionalData = (runId: string, index: number, last: boolean) => new TextEncoder().encode(`${runId}:${index}:${last ? "last" : "more"}`);

const importKey = (key: string) =>
  io("backup.key", () => crypto.subtle.importKey("raw", Buffer.from(key, "base64url"), "AES-GCM", false, ["encrypt", "decrypt"]));

const checkInput = (input: BackupScheduleInput) => Effect.gen(function* () {
  if (!isRecord(input) || typeof input.name !== "string" || !NAME.test(input.name)) return yield* refuse("A schedule name is 1 to 64 letters, digits, dots, dashes or underscores.");
  if (!Number.isSafeInteger(input.keep) || input.keep < 1 || input.keep > 1000) return yield* refuse("keep is a whole number from 1 to 1000.");
  const parsed = Cron.parse(String(input.cron), input.timeZone);
  if (Result.isFailure(parsed)) return yield* refuse(`"${String(input.cron)}" is not a cron expression: ${parsed.failure.message}`);
  const target = input.target;
  if (!isRecord(target)) return yield* refuse("A target is { kind: \"directory\", path } or { kind: \"s3\", bucket, region, accessKeyId, secretAccessKey, endpoint?, prefix? }.");
  if (target.kind === "directory") {
    if (typeof target.path !== "string" || !target.path.startsWith("/")) return yield* refuse("A directory target needs an absolute path.");
  } else if (target.kind === "s3") {
    for (const field of ["bucket", "region", "accessKeyId", "secretAccessKey"] as const) {
      if (typeof target[field] !== "string" || target[field].length === 0) return yield* refuse(`An s3 target needs ${field}.`);
    }
  } else return yield* refuse(`A target's kind is directory or s3, not "${String((target as { readonly kind?: unknown }).kind)}".`);
  return parsed.success;
});

export interface DatabaseBackupsHost {
  readonly schedules: () => Promise<ReadonlyArray<BackupSchedule>>;
  /** Make a schedule; its `recoveryKey` is answered here and never again. */
  readonly createSchedule: (input: BackupScheduleInput) => Promise<BackupSchedule & { readonly recoveryKey: string }>;
  readonly deleteSchedule: (name: string) => Promise<{ readonly name: string }>;
  /** Run a schedule now, outside its times. */
  readonly runNow: (name: string) => Promise<BackupRun>;
  readonly runs: (name?: string) => Promise<ReadonlyArray<BackupRun>>;
  readonly verify: (name: string, runId: string) => Promise<BackupRun>;
  /** Restore a run into an image directory on this host; `recoveryKey` when the host's copy of the key is gone. */
  readonly restore: (name: string, runId: string, options?: { readonly recoveryKey?: string }) => Promise<BackupRun>;
  /** Drill the schedule's newest good run (or `runId`): restore into a fresh directory, open it, measure, clean up. */
  readonly drill: (name: string, runId?: string) => Promise<BackupRun>;
  /**
   * Drill a run another host made, as a machine that lost that host would: from the target, the schedule's name
   * and its recovery key alone, holding none of that host's state. The newest finished run unless `runId` names one.
   * Nothing is recorded here and nothing is kept: the copy is restored into a fresh directory, opened, measured and removed.
   */
  readonly drillFrom: (input: { readonly target: BackupTarget; readonly schedule: string; readonly recoveryKey: string; readonly runId?: string }) => Promise<ForeignDrill>;
}

/** A database's component: an image of every shard in `engine`, which is what a restore opens. */
export const databaseComponent = (database: DatabaseApi, engine: string): BackupComponent => ({
  name: "database",
  stage: (into) => Effect.asVoid(database.maintenance.image(destinationEngine(
    (engine === "lmdb" || engine === "rocksdb" ? engine : "sqlite") as "sqlite" | "lmdb" | "rocksdb", into)).pipe(Effect.mapError(failed("backup.image")))),
});

/**
 * A SQLite file copied consistently while it is in use (`VACUUM INTO`, from a read-only connection), through the
 * host's own binding: `node:sqlite` on Node, `bun:sqlite` on Bun.
 */
export const sqliteFileComponent = (name: string, file: string): BackupComponent => ({
  name,
  stage: (into) => Effect.gen(function* () {
    const openSqlite = yield* io("backup.sqlite", () => loadSqliteOpener());
    const target = join(into, "store.sqlite");
    yield* io("backup.sqlite", () => {
      const source = openSqlite(file, true);
      try { source.prepare("VACUUM INTO ?").run(target); } finally { source.close(); }
    });
  }),
});

/** A directory's files as they are when the run reads them; files written meanwhile may or may not be in it. */
export const directoryComponent = (name: string, directory: string): BackupComponent => ({
  name,
  stage: (into) => io("backup.copy", () => import("node:fs/promises").then(({ cp }) =>
    cp(directory, into, { recursive: true, force: true, errorOnExist: false }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code !== "ENOENT") throw cause;
    }))),
});

/** Backups of `components` on this host, their state kept in `directory`; schedules run while `scope` is open. */
export const backupsHost = (
  options: { readonly directory: string; readonly components: ReadonlyArray<BackupComponent>; readonly scope: Scope.Scope },
): Effect.Effect<DatabaseBackupsHost> =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    const running = yield* FiberMap.make<string>().pipe(Scope.provide(options.scope));
    const statePath = join(options.directory, STATE_FILE);

    const readState = io("backup.state", () => readFile(statePath, "utf8")).pipe(
      Effect.map((text) => parseJson(text, stateRecord, "backup state")),
      Effect.catch(() => Effect.succeed<State>({ schedules: [], runs: [] })),
    );
    const writeState = (state: State) => Effect.gen(function* () {
      yield* io("backup.state", () => mkdir(options.directory, { recursive: true }));
      const temporary = `${statePath}.${crypto.randomUUID()}`;
      yield* io("backup.state", () => writeFile(temporary, JSON.stringify(state), { mode: 0o600 }));
      yield* io("backup.state", () => rename(temporary, statePath));
    });
    /** Change the state under the one permit, so two runs never write over each other's records. */
    const update = <A>(change: (state: State) => readonly [State, A]) =>
      permit.withPermits(1)(Effect.gen(function* () {
        const [next, answer] = change(yield* readState);
        yield* writeState(next);
        return answer;
      }));
    const recordRun = (run: BackupRun) => update((state) => [{
      ...state,
      runs: [...state.runs.filter((entry) => !(entry.schedule === run.schedule && entry.runId === run.runId)), run].slice(-RUNS_KEPT),
    }, run] as const);
    const scheduleNamed = (name: string) => Effect.flatMap(readState, (state) => {
      const found = state.schedules.find((entry) => entry.name === name);
      return found === undefined ? Effect.fail(refuse(`No backup schedule is named "${name}".`)) : Effect.succeed(found);
    });
    const answer = (stored: StoredSchedule): BackupSchedule => {
      const parsed = Cron.parse(stored.cron, stored.timeZone);
      const { key: _key, target, ...rest } = stored;
      return {
        ...rest, target: { kind: target.kind, location: locationOf(target) }, keyFingerprint: fingerprint(stored.key),
        ...(Result.isSuccess(parsed) ? { nextRunAt: Cron.next(parsed.success).toISOString() } : {}),
      };
    };

    /** Every file of an image directory, with its path relative to it. */
    const filesOf = (root: string): Effect.Effect<ReadonlyArray<string>, InvalidBackup> =>
      io("backup.list", () => readdir(root, { recursive: true, withFileTypes: true })).pipe(
        Effect.map((entries) => entries.filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name))).sort()),
      );

    const runSchedule = (stored: StoredSchedule) =>
      Effect.gen(function* () {
        const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
        const started: BackupRun = { schedule: stored.name, runId, startedAt: new Date().toISOString(), status: "running" };
        yield* recordRun(started);
        const staging = join(options.directory, `.run-${runId}`);
        const outcome = yield* Effect.gen(function* () {
          for (const component of options.components) {
            const into = join(staging, component.name);
            yield* io("backup.stage", () => mkdir(into, { recursive: true }));
            yield* component.stage(into);
          }
          const storage = storageOf(stored.target);
          const key = yield* importKey(stored.key);
          const prefix = new Uint8Array(randomBytes(4));
          const digest = createHash("sha256");
          let part = new Uint8Array(PART_BYTES), filled = 0, index = 0, bytes = 0;
          const flush = (last: boolean) => Effect.gen(function* () {
            const plain = part.subarray(0, filled);
            const sealed = new Uint8Array(yield* io("backup.encrypt", () => crypto.subtle.encrypt(
              { name: "AES-GCM", iv: nonceOf(prefix, index), additionalData: additionalData(runId, index, last) }, key, plain)));
            yield* io("backup.upload", () => storage.put({ path: `${stored.name}/${runId}/part-${String(index).padStart(6, "0")}`, body: sealed, condition: { ifAbsent: true } }));
            index += 1;
            part = new Uint8Array(PART_BYTES);
            filled = 0;
          });
          const append = (chunk: Uint8Array) => Effect.gen(function* () {
            digest.update(chunk);
            bytes += chunk.length;
            let at = 0;
            while (at < chunk.length) {
              const take = Math.min(chunk.length - at, PART_BYTES - filled);
              part.set(chunk.subarray(at, at + take), filled);
              filled += take; at += take;
              if (filled === PART_BYTES) yield* flush(false);
            }
          });
          for (const file of yield* filesOf(staging)) {
            const path = new TextEncoder().encode(file.split(sep).join("/"));
            const handle = yield* io("backup.read", () => open(join(staging, file), "r"));
            yield* Effect.gen(function* () {
              const size = (yield* io("backup.read", () => handle.stat())).size;
              const header = new Uint8Array(12 + path.length);
              const view = new DataView(header.buffer);
              view.setUint32(0, path.length);
              header.set(path, 4);
              view.setBigUint64(4 + path.length, BigInt(size));
              yield* append(header);
              const buffer = new Uint8Array(READ_BYTES);
              for (let offset = 0; offset < size;) {
                const { bytesRead } = yield* io("backup.read", () => handle.read(buffer, 0, Math.min(READ_BYTES, size - offset), offset));
                if (bytesRead === 0) return yield* refuse(`${file} ended before its ${size} bytes`);
                yield* append(buffer.subarray(0, bytesRead));
                offset += bytesRead;
              }
            }).pipe(Effect.ensuring(Effect.orDie(io("backup.read", () => handle.close()))));
          }
          yield* flush(true);
          const manifest: Manifest = {
            format: "zelavis.backup.v1", components: options.components.map((component) => component.name),
            schedule: stored.name, runId, createdAt: started.startedAt, parts: index, bytes,
            sha256: digest.digest("hex"), keyFingerprint: fingerprint(stored.key), noncePrefix: Buffer.from(prefix).toString("hex"),
          };
          // The commit point: a run is offered only once its manifest exists.
          yield* io("backup.upload", () => storage.put({ path: `${stored.name}/${runId}/manifest.json`, body: JSON.stringify(manifest), contentType: "application/json", condition: { ifAbsent: true } }));
          yield* prune(stored, storage);
          return { ...started, status: "ok" as const, finishedAt: new Date().toISOString(), bytes, parts: index };
        }).pipe(
          Effect.catchCause((cause) => Effect.succeed<BackupRun>({ ...started, status: "failed", finishedAt: new Date().toISOString(), error: String(cause).slice(0, 2000) })),
          Effect.ensuring(Effect.orDie(io("backup.stage", () => rm(staging, { recursive: true, force: true })))),
        );
        return yield* recordRun(outcome);
      });

    /** Keep the newest `keep` runs at the target: older ones lose their manifest first, then their parts. */
    const prune = (stored: StoredSchedule, storage: ZelavisFileStorage) => Effect.gen(function* () {
      if (storage.list === undefined) return;
      const entries = yield* io("backup.list", () => storage.list!(`${stored.name}/`));
      const runs = [...new Set(entries.filter((entry) => entry.path.endsWith("/manifest.json")).map((entry) => entry.path.split("/").at(-2)!))].sort();
      for (const runId of runs.slice(0, Math.max(0, runs.length - stored.keep))) {
        yield* io("backup.prune", () => storage.delete(`${stored.name}/${runId}/manifest.json`));
        for (const entry of entries.filter((item) => item.path.startsWith(`${stored.name}/${runId}/part-`))) {
          yield* io("backup.prune", () => storage.delete(entry.path));
        }
      }
    });

    /** Every part of a run decrypted in order, handed to `use`; the digest is checked against the manifest. */
    const readRun = (stored: StoredSchedule, runId: string, keyText: string, use: (chunk: Uint8Array) => Effect.Effect<void, InvalidBackup>) =>
      Effect.gen(function* () {
        const storage = storageOf(stored.target);
        const manifestObject = yield* io("backup.download", () => storage.get(`${stored.name}/${runId}/manifest.json`));
        if (manifestObject === undefined) return yield* refuse(`Run "${runId}" of "${stored.name}" has no manifest: it was never finished, or it was removed.`);
        const manifest = parseJson(new TextDecoder().decode(manifestObject.body), manifestRecord, "backup manifest");
        if (manifest.keyFingerprint !== fingerprint(keyText)) return yield* refuse("That key is not the key this run was written with.");
        const key = yield* importKey(keyText);
        const prefix = Buffer.from(manifest.noncePrefix, "hex");
        const digest = createHash("sha256");
        for (let index = 0; index < manifest.parts; index++) {
          const sealed = yield* io("backup.download", () => storage.get(`${stored.name}/${runId}/part-${String(index).padStart(6, "0")}`));
          if (sealed === undefined) return yield* refuse(`Part ${index} of run "${runId}" is missing.`);
          const plain = new Uint8Array(yield* io(`backup.decrypt part ${index}`, () => crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonceOf(prefix, index), additionalData: additionalData(runId, index, index === manifest.parts - 1) }, key, new Uint8Array(sealed.body))));
          digest.update(plain);
          yield* use(plain);
        }
        if (digest.digest("hex") !== manifest.sha256) return yield* refuse(`Run "${runId}" does not match its manifest's digest.`);
        return manifest;
      });

    const recordedRun = (name: string, runId: string) => Effect.map(readState, (state) =>
      state.runs.find((entry) => entry.schedule === name && entry.runId === runId) ?? { schedule: name, runId, startedAt: "", status: "ok" as const });

    const verify = (name: string, runId: string) => Effect.gen(function* () {
      const stored = yield* scheduleNamed(name);
      const ok = yield* Effect.as(readRun(stored, runId, stored.key, () => Effect.void), true).pipe(Effect.catch(() => Effect.succeed(false)));
      return yield* recordRun({ ...(yield* recordedRun(name, runId)), verifiedAt: new Date().toISOString(), verified: ok });
    });

    const restore = (name: string, runId: string, restoreOptions?: { readonly recoveryKey?: string }) =>
      Effect.flatMap(unpack(name, runId, join(options.directory, "restored", `${name}-${runId}`), restoreOptions?.recoveryKey), (into) =>
        Effect.flatMap(recordedRun(name, runId), (run) => recordRun({ ...run, restoredTo: into })));

    /** A run decrypted and unpacked into `into`, one folder per component. */
    const unpack = (name: string, runId: string, into: string, recoveryKey?: string) =>
      Effect.flatMap(scheduleNamed(name), (stored) => unpackStored(stored, runId, into, recoveryKey));
    const unpackStored = (stored: StoredSchedule, runId: string, into: string, recoveryKey?: string) => Effect.gen(function* () {
      const root = resolve(into);
      yield* io("backup.restore", () => rm(into, { recursive: true, force: true }));
      yield* io("backup.restore", () => mkdir(into, { recursive: true }));
      // The archive is files one after another: a header (path, size), then that many bytes.
      let pending = new Uint8Array(0);
      let file: { readonly handle: import("node:fs/promises").FileHandle; remaining: number } | undefined;
      const consume = (chunk: Uint8Array) => Effect.gen(function* () {
        let data: Uint8Array = pending.length === 0 ? chunk : new Uint8Array([...pending, ...chunk]);
        pending = new Uint8Array(0);
        while (data.length > 0) {
          if (file !== undefined) {
            const take = Math.min(file.remaining, data.length);
            const current = file;
            yield* io("backup.restore", () => current.handle.write(data.subarray(0, take)));
            file.remaining -= take;
            data = data.subarray(take);
            if (file.remaining === 0) { yield* io("backup.restore", () => current.handle.close()); file = undefined; }
            continue;
          }
          if (data.length < 4) { pending = data.slice(); return; }
          const length = new DataView(data.buffer, data.byteOffset).getUint32(0);
          if (data.length < 12 + length) { pending = data.slice(); return; }
          const path = new TextDecoder().decode(data.subarray(4, 4 + length));
          const size = Number(new DataView(data.buffer, data.byteOffset).getBigUint64(4 + length));
          const target = resolve(root, path);
          if (!target.startsWith(`${root}${sep}`)) return yield* refuse(`The archive names a path outside its directory: ${path}`);
          yield* io("backup.restore", () => mkdir(dirname(target), { recursive: true }));
          const handle = yield* io("backup.restore", () => open(target, "w", 0o600));
          if (size === 0) yield* io("backup.restore", () => handle.close());
          else file = { handle, remaining: size };
          data = data.subarray(12 + length);
        }
      });
      // The file being written is closed however the read ends, interruption included (a drill cut off when its
      // schedule stops): a handle left to the garbage collector is an error in Node.
      const closeOpen = Effect.suspend(() => {
        const left = file;
        file = undefined;
        return left === undefined ? Effect.void : Effect.orDie(io("backup.restore", () => left.handle.close()));
      });
      const result = yield* readRun(stored, runId, recoveryKey ?? stored.key, consume).pipe(Effect.result, Effect.ensuring(closeOpen));
      if (Result.isFailure(result)) {
        yield* Effect.orDie(io("backup.restore", () => rm(into, { recursive: true, force: true })));
        return yield* result.failure;
      }
      return into;
    });

    /**
     * A managed app's component, checked as a restore would use it: its summary names every directory captured,
     * and each is there and holds something.
     */
    const inspectApp = (into: string) => Effect.gen(function* () {
      const app = join(into, "app");
      const text = yield* io("backup.drill", () => readFile(join(app, "recipe.json"), "utf8")).pipe(Effect.orElseSucceed(() => undefined));
      if (text === undefined) return {};
      const summary = parseJson(text, appSummaryRecord, "app backup summary");
      const captured: string[] = [];
      const missing: string[] = [];
      for (const directory of summary.directories) {
        if (directory.captured === null) { missing.push(directory.name); continue; }
        const files = yield* filesOf(join(app, directory.captured)).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        if (files.length === 0) return yield* refuse(`The app's "${directory.name}" was captured as ${directory.captured}, which the run does not hold.`);
        captured.push(directory.name);
      }
      return { app: { recipe: summary.recipe, captured, missing } };
    });

    /** What a restored copy holds, opened the way it would be used: a database by its own opener. */
    const inspect = (into: string) => Effect.map(Effect.zip(inspectDatabase(into), inspectApp(into)), ([held, app]) => ({ ...held, ...app }));
    const inspectDatabase = (into: string) => Effect.gen(function* () {
      const database = join(into, "database");
      if ((yield* filesOf(database).pipe(Effect.orElseSucceed(() => []))).length > 0) {
        const { openNodeDatabase } = yield* io("backup.drill", () => import("./node-host.js"));
        const opened = yield* io("backup.drill", () => openNodeDatabase({ directory: database, crossTenantRefresh: false }));
        return yield* io("backup.drill", () => opened.api.tenantUsage()).pipe(
          // Reserved partitions (`zv.`) hold the database's own state, not a Tenant's.
          Effect.map((usage) => usage.filter((row) => !row.tenant.startsWith("zv."))),
          Effect.map((usage) => ({ tenants: new Set(usage.map((row) => row.tenant.split("#")[0])).size, records: usage.reduce((sum, row) => sum + row.records, 0) })),
          Effect.ensuring(Effect.orDie(io("backup.drill", () => opened.close()))),
        );
      }
      const lines = yield* io("backup.drill", () => readFile(join(into, "system-store", "records.jsonl"), "utf8")).pipe(Effect.orElseSucceed(() => ""));
      return { records: lines.split("\n").filter((line) => line.trim() !== "").length };
    });

    const drill = (name: string, runId?: string) => Effect.gen(function* () {
      const chosen = runId ?? (yield* readState).runs.filter((entry) => entry.schedule === name && entry.status === "ok").at(-1)?.runId;
      if (chosen === undefined) return yield* refuse(`Schedule "${name}" has no finished run to drill.`);
      const run = yield* recordedRun(name, chosen);
      const into = join(options.directory, "drills", `${name}-${chosen}-${randomBytes(3).toString("hex")}`);
      const started = Date.now();
      const outcome = yield* Effect.flatMap(unpack(name, chosen, into), inspect).pipe(
        Effect.map((held): BackupDrill => ({ at: new Date().toISOString(), ok: true, rtoMs: Date.now() - started, rpoMs: started - Date.parse(run.startedAt), ...held })),
        Effect.catch((error) => Effect.succeed<BackupDrill>({ at: new Date().toISOString(), ok: false, rtoMs: Date.now() - started, rpoMs: started - Date.parse(run.startedAt), error: error.message })),
        Effect.ensuring(Effect.orDie(io("backup.drill", () => rm(into, { recursive: true, force: true })))),
      );
      return yield* recordRun({ ...run, drill: outcome });
    });

    const drillFrom = (input: { readonly target: BackupTarget; readonly schedule: string; readonly recoveryKey: string; readonly runId?: string }) => Effect.gen(function* () {
      if (!isRecord(input) || typeof input.schedule !== "string" || !NAME.test(input.schedule)) return yield* refuse("A schedule name is 1 to 64 letters, digits, dots, dashes or underscores.");
      if (typeof input.recoveryKey !== "string" || input.recoveryKey.length === 0) return yield* refuse("A drill from another host needs the schedule's recovery key.");
      // The same target rules a schedule's are held to, checked by the same function on a stand-in schedule.
      yield* checkInput({ name: input.schedule, cron: "0 0 * * *", keep: 1, target: input.target });
      const stored: StoredSchedule = { name: input.schedule, cron: "0 0 * * *", keep: 1, target: input.target, createdAt: "", key: input.recoveryKey };
      const storage = storageOf(input.target);
      let runId = input.runId;
      if (runId === undefined) {
        if (storage.list === undefined) return yield* refuse("This target cannot list its runs; name the run to drill.");
        const entries = yield* io("backup.list", () => storage.list!(`${input.schedule}/`));
        runId = entries.filter((entry) => entry.path.endsWith("/manifest.json")).map((entry) => entry.path.split("/").at(-2)!).sort().at(-1);
        if (runId === undefined) return yield* refuse(`The target holds no finished run of "${input.schedule}".`);
      }
      if (!NAME.test(runId)) return yield* refuse("A run id is what the run was recorded as.");
      const chosen = runId;
      const manifestObject = yield* io("backup.download", () => storage.get(`${input.schedule}/${chosen}/manifest.json`));
      if (manifestObject === undefined) return yield* refuse(`Run "${chosen}" of "${input.schedule}" has no manifest: it was never finished, or it was removed.`);
      const createdAt = parseJson(new TextDecoder().decode(manifestObject.body), manifestRecord, "backup manifest").createdAt;
      const into = join(options.directory, "drills", `foreign-${input.schedule}-${chosen}-${randomBytes(3).toString("hex")}`);
      const started = Date.now();
      const outcome = yield* Effect.flatMap(unpackStored(stored, chosen, into, input.recoveryKey), inspect).pipe(
        Effect.map((held): BackupDrill => ({ at: new Date().toISOString(), ok: true, rtoMs: Date.now() - started, rpoMs: started - Date.parse(createdAt), ...held })),
        Effect.catch((error) => Effect.succeed<BackupDrill>({ at: new Date().toISOString(), ok: false, rtoMs: Date.now() - started, rpoMs: started - Date.parse(createdAt), error: error.message })),
        Effect.ensuring(Effect.orDie(io("backup.drill", () => rm(into, { recursive: true, force: true })))),
      );
      return { ...outcome, schedule: input.schedule, runId: chosen, createdAt };
    });

    /** One schedule's loop: sleep until its next time, run, again; a failed run is recorded and the loop goes on. */
    const loop = (stored: StoredSchedule) => Effect.gen(function* () {
      const cron = Cron.parseUnsafe(stored.cron, stored.timeZone);
      for (;;) {
        yield* Effect.sleep(Duration.millis(Math.max(0, Cron.next(cron).getTime() - Date.now())));
        const made = yield* runSchedule(stored);
        if (stored.drillAfterRun === true && made.status === "ok") yield* drill(stored.name, made.runId).pipe(
          Effect.catchCause((cause) => Effect.logWarning(`Drill after backup run ${made.runId} of "${stored.name}" could not run`, cause)));
      }
    });
    const startLoop = (stored: StoredSchedule) => FiberMap.run(running, stored.name, loop(stored));

    for (const stored of (yield* readState.pipe(Effect.orDie)).schedules) yield* startLoop(stored);

    const run = <A>(effect: Effect.Effect<A, InvalidBackup>) => Effect.runPromise(effect);
    return {
      schedules: () => run(Effect.map(readState, (state) => state.schedules.map(answer))),
      createSchedule: (input) => run(Effect.gen(function* () {
        yield* checkInput(input);
        if ((yield* readState).schedules.some((entry) => entry.name === input.name)) return yield* refuse(`A schedule named "${input.name}" already exists.`);
        const probe = yield* io("backup.target", () => probeFileStorageGuarantees(storageOf(input.target), { prefix: `${input.name}/.probe` }));
        if (!probe.conformant) return yield* refuse(`The target does not keep conditional writes, so it cannot hold backups: ${probe.violation}`);
        const key = randomBytes(32).toString("base64url");
        const stored: StoredSchedule = {
          name: input.name, cron: input.cron, ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }), keep: input.keep, target: input.target,
          ...(input.drillAfterRun === true ? { drillAfterRun: true } : {}), createdAt: new Date().toISOString(), key,
        };
        // Checked and added under the one permit, so two requests cannot both make the same name.
        const added = yield* update((state) => state.schedules.some((entry) => entry.name === input.name)
          ? [state, false] as const
          : [{ ...state, schedules: [...state.schedules, stored] }, true] as const);
        if (!added) return yield* refuse(`A schedule named "${input.name}" already exists.`);
        yield* startLoop(stored);
        return { ...answer(stored), recoveryKey: key };
      })),
      deleteSchedule: (name) => run(Effect.gen(function* () {
        yield* scheduleNamed(name);
        yield* FiberMap.remove(running, name);
        yield* update((state) => [{ ...state, schedules: state.schedules.filter((entry) => entry.name !== name) }, undefined] as const);
        return { name };
      })),
      runNow: (name) => run(Effect.flatMap(scheduleNamed(name), runSchedule)),
      runs: (name) => run(Effect.map(readState, (state) => state.runs.filter((entry) => name === undefined || entry.schedule === name).reverse())),
      verify: (name, runId) => run(verify(name, runId)),
      restore: (name, runId, restoreOptions) => run(restore(name, runId, restoreOptions)),
      drill: (name, runId) => run(drill(name, runId)),
      drillFrom: (input) => run(drillFrom(input)),
    };
  });
