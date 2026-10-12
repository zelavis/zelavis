import { Duration, Effect, Schedule } from "effect";
import { presignUrl } from "./presign.js";

/**
 * Builds PHP on the host this Platform runs on, through fixed host operations, and publishes the result.
 *
 * Authority: this code has none of its own. Every operation is submitted with the principal of the person who
 * asked, so the broker checks that person's permissions, and only the operations the manifest names are
 * reachable. A build runs for longer than an operation may, so what is kept here is only a record per job: which
 * version, when, and what the host last reported. The host's own state (a labeled container) is the truth.
 */

export interface BuildPrincipal { readonly id?: string; readonly [key: string]: unknown }

export interface OperationRecord {
  readonly operationId: string;
  readonly agent?: { readonly status: string; readonly result?: Readonly<Record<string, unknown>>; readonly resultError?: string; readonly exitCode?: number };
}

export interface OperationsHandle {
  readonly allowed: readonly string[];
  submit(input: { readonly operation: string; readonly version?: string; readonly arguments?: Readonly<Record<string, string>>; readonly deadlineMs?: number }, principal: any): Promise<OperationRecord>;
  get(operationId: string, principal: any): Promise<OperationRecord>;
}

export interface JobStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: any): Promise<void>;
  delete(key: string): Promise<boolean>;
  list(): Promise<readonly { key: string; value: unknown }[]>;
}

export interface BuildDeps {
  readonly operations: OperationsHandle;
  readonly store: JobStore;
  /** Operator-managed settings (the mirror's storage credentials); never stored by this service and never returned. */
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
  readonly newJob: () => string;
  readonly pollMs?: number;
  readonly waitMs?: number;
}

export type BuildState = "starting" | "running" | "succeeded" | "failed" | "missing" | "cleaned";

export interface BuiltArchive { readonly file: string; readonly sha256: string; readonly bytes: number }
export interface UploadRecord { readonly operationId: string; state: "uploading" | "verified" | "mismatch" | "failed"; sha256?: string; message?: string }

export interface BuildRecord {
  job: string;
  php: string;
  createdAt: string;
  state: BuildState;
  exitCode?: number | null;
  log?: string;
  message?: string;
  platform?: string;
  builds?: BuiltArchive[];
  uploads?: Record<string, UploadRecord>;
}

/** A refusal or failure with the HTTP status a route should answer with. */
export class BuildError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "BuildError"; }
}

const PHP_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const JOB = /^[a-f0-9]{16}$/;
const ACTIVE = new Set(["queued", "running"]);
const KEY = (job: string) => `job:${job}`;

const fromBroker = (error: unknown): BuildError => {
  if (error instanceof BuildError) return error;
  const named = error as { name?: string; message?: string; status?: number };
  if (named?.name === "ZelavisHostOperationForbiddenError") return new BuildError(named.status ?? 403, named.message ?? "Not permitted.");
  if (named?.name === "ZelavisHostOperationNotFoundError") return new BuildError(404, named.message ?? "Not found.");
  if (named?.name === "ZelavisHostOperationValidationError") return new BuildError(400, named.message ?? "Invalid request.");
  if (named?.name === "ZelavisHostOperationRateLimitedError") return new BuildError(429, named.message ?? "Too many requests.");
  return new BuildError(502, named?.message ?? "The host operation failed.");
};

export function createBuilds(deps: BuildDeps) {
  const pollMs = deps.pollMs ?? 1_000;
  const waitMs = deps.waitMs ?? 120_000;

  class NotDone { readonly _tag = "NotDone"; }

  /** Waits for an operation to leave the queue and the Agent, then answers with its result. */
  const settle = (operationId: string, principal: unknown, limitMs: number) =>
    Effect.tryPromise({ try: () => deps.operations.get(operationId, principal), catch: fromBroker }).pipe(
      Effect.flatMap((record) => ACTIVE.has(record.agent?.status ?? "queued") || record.agent === undefined
        ? Effect.fail(new NotDone())
        : Effect.succeed(record)),
      Effect.retry({ schedule: Schedule.spaced(Duration.millis(pollMs)), while: (error) => error instanceof NotDone }),
      Effect.timeoutOrElse({ duration: Duration.millis(limitMs), orElse: () => Effect.fail(new BuildError(504, "The host did not answer in time.")) }),
      Effect.mapError((error) => error instanceof NotDone ? new BuildError(504, "The host did not answer in time.") : fromBroker(error)),
    );

  const run = (operation: string, args: Record<string, string>, principal: unknown, limitMs = waitMs) =>
    Effect.tryPromise({ try: () => deps.operations.submit({ operation, version: "v1", arguments: args, deadlineMs: Math.min(900_000, Math.max(30_000, limitMs)) }, principal), catch: fromBroker }).pipe(
      Effect.flatMap((submitted) => settle(submitted.operationId, principal, limitMs)),
      Effect.flatMap((record) => record.agent?.status === "succeeded" && record.agent.result
        ? Effect.succeed(record.agent.result)
        : Effect.fail(new BuildError(502, record.agent?.resultError ?? `${operation} failed${record.agent?.exitCode === undefined ? "" : ` (exit ${record.agent.exitCode})`}.`))),
    );

  const load = (job: string) => Effect.gen(function* () {
    if (!JOB.test(job)) return yield* Effect.fail(new BuildError(400, "That is not a build id."));
    const value = yield* Effect.tryPromise({ try: () => deps.store.get(KEY(job)), catch: fromBroker });
    if (!value) return yield* Effect.fail(new BuildError(404, "No such build."));
    return value as BuildRecord;
  });
  const save = (record: BuildRecord) => Effect.tryPromise({ try: () => deps.store.set(KEY(record.job), record), catch: fromBroker });

  /** What the host reports now, merged into the record. */
  const refresh = (record: BuildRecord, principal: unknown) => Effect.gen(function* () {
    if (record.state === "cleaned") return record;
    const status = yield* run("zelavis.php-build-status", { job: record.job }, principal, 60_000);
    const state = String(status.state);
    record.log = typeof status.log === "string" ? status.log : record.log;
    record.exitCode = typeof status.exitCode === "number" ? status.exitCode : null;
    if (state === "missing") record.state = record.state === "starting" ? "starting" : "missing";
    else if (state === "exited") record.state = status.exitCode === 0 ? "succeeded" : "failed";
    else record.state = "running";
    if (Array.isArray(status.builds)) record.builds = status.builds as BuiltArchive[];
    // Uploads in flight: the broker knows how each ended.
    for (const [file, upload] of Object.entries(record.uploads ?? {})) {
      if (upload.state !== "uploading") continue;
      const operation = yield* Effect.tryPromise({ try: () => deps.operations.get(upload.operationId, principal), catch: fromBroker });
      const agent = operation.agent;
      if (!agent || ACTIVE.has(agent.status)) continue;
      if (agent.status !== "succeeded") { upload.state = "failed"; upload.message = agent.resultError ?? "The upload failed."; continue; }
      const expected = record.builds?.find((build) => build.file === file)?.sha256;
      upload.sha256 = typeof agent.result?.sha256 === "string" ? agent.result.sha256 : undefined;
      upload.state = expected !== undefined && upload.sha256 === expected ? "verified" : "mismatch";
    }
    yield* save(record);
    return record;
  });

  const mirror = () => {
    const env = deps.environment;
    const account = env.ZELAVIS_PHP_BUILDS_R2_ACCOUNT_ID, bucket = env.ZELAVIS_PHP_BUILDS_R2_BUCKET;
    const accessKeyId = env.ZELAVIS_PHP_BUILDS_R2_ACCESS_KEY_ID, secretAccessKey = env.ZELAVIS_PHP_BUILDS_R2_SECRET_ACCESS_KEY;
    if (!account || !bucket || !accessKeyId || !secretAccessKey) return undefined;
    if (!/^[a-z0-9]{8,64}$/.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) return undefined;
    return { account, bucket, accessKeyId, secretAccessKey, publicBase: (env.ZELAVIS_PHP_BUILDS_PUBLIC_URL ?? "").replace(/\/+$/, "") };
  };

  const programs = {
    /** The host's facts and whether a build can start here, from two read-only operations. */
    host: (principal: unknown) => Effect.gen(function* () {
      const [report, containers] = yield* Effect.all([
        run("zelavis.host-report", {}, principal, 60_000),
        run("zelavis.container-probe", {}, principal, 60_000),
      ], { concurrency: 2 });
      return { report, containers, mirror: { configured: mirror() !== undefined, publicBase: mirror()?.publicBase ?? "" } };
    }),

    start: (principal: unknown, input: unknown) => Effect.gen(function* () {
      const php = (input as { php?: unknown } | undefined)?.php;
      if (typeof php !== "string" || !PHP_VERSION.test(php)) return yield* Effect.fail(new BuildError(400, "php must be an exact version such as 8.4.23."));
      const record: BuildRecord = { job: deps.newJob(), php, createdAt: deps.now().toISOString(), state: "starting" };
      // Written first: a crash between the host starting the build and this record would leave a build nobody lists.
      yield* save(record);
      const started = yield* run("zelavis.php-build-start", { job: record.job, php }, principal).pipe(
        Effect.tapError((error) => Effect.sync(() => { record.state = "failed"; record.message = error.message; }).pipe(Effect.andThen(save(record)), Effect.ignore)),
      );
      record.state = "running";
      if (typeof started.platform === "string") record.platform = started.platform;
      yield* save(record);
      return record;
    }),

    list: () => Effect.tryPromise({ try: () => deps.store.list(), catch: fromBroker }).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.key.startsWith("job:")).map((entry) => entry.value as BuildRecord)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 50)),
    ),

    get: (principal: unknown, job: string) => load(job).pipe(Effect.flatMap((record) => refresh(record, principal))),

    upload: (principal: unknown, job: string) => Effect.gen(function* () {
      const settings = mirror();
      if (!settings) return yield* Effect.fail(new BuildError(409, "The mirror is not configured: set the ZELAVIS_PHP_BUILDS_R2_* variables in the Platform's environment file."));
      const record = yield* load(job).pipe(Effect.flatMap((loaded) => refresh(loaded, principal)));
      if (record.state !== "succeeded" || !record.builds?.length) return yield* Effect.fail(new BuildError(409, "The build has not finished successfully."));
      record.uploads ??= {};
      for (const build of record.builds) {
        const existing = record.uploads[build.file];
        if (existing && (existing.state === "uploading" || existing.state === "verified")) continue;
        const url = presignUrl({
          method: "PUT", host: `${settings.account}.r2.cloudflarestorage.com`, path: `/${settings.bucket}/php/${record.php}/${build.file}`,
          region: "auto", accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey, expiresSeconds: 3_600, now: deps.now(),
        });
        const submitted = yield* Effect.tryPromise({
          try: () => deps.operations.submit({ operation: "zelavis.php-build-upload", version: "v1", arguments: { file: build.file, job: record.job, url }, deadlineMs: 900_000 }, principal),
          catch: fromBroker,
        });
        record.uploads[build.file] = { operationId: submitted.operationId, state: "uploading" };
      }
      yield* save(record);
      return record;
    }),

    clean: (principal: unknown, job: string) => Effect.gen(function* () {
      const record = yield* load(job);
      yield* run("zelavis.php-build-clean", { job }, principal, 120_000);
      record.state = "cleaned";
      yield* save(record);
      return record;
    }),
  };

  const asPromise = <A>(program: Effect.Effect<A, BuildError>) => Effect.runPromise(program).catch((cause) => { throw cause instanceof Error ? cause : new BuildError(500, String(cause)); });
  return {
    host: (principal: unknown) => asPromise(programs.host(principal)),
    start: (principal: unknown, input: unknown) => asPromise(programs.start(principal, input)),
    list: () => asPromise(programs.list()),
    get: (principal: unknown, job: string) => asPromise(programs.get(principal, job)),
    upload: (principal: unknown, job: string) => asPromise(programs.upload(principal, job)),
    clean: (principal: unknown, job: string) => asPromise(programs.clean(principal, job)),
    publicUrl: (record: BuildRecord, file: string) => { const base = mirror()?.publicBase; return base ? `${base}/php/${record.php}/${file}` : undefined; },
  };
}

export type Builds = ReturnType<typeof createBuilds>;
