import { Cause, Effect } from "effect";
import { isValidTenantId } from "../../db/naming.js";
import type { DatabaseRuntimeApi } from "../../db/runtime-api.js";
import {
  createModuleDataUrl, DEFAULT_SIGNATURE_HEADER, eventIdOf, isCronExpression, JOB_ENTITY, keptHeaders,
  RESERVED_ENTITY_TYPES, TIMESTAMPED_SIGNATURE_HEADER, verifySignature, verifyTimestampedSignature, WEBHOOK_ENTITY,
} from "./durable.js";
import { present, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "../../core/runtime/effect-boundary.js";
import { createJsonErrorResponse } from "../../core/runtime/http-errors.js";
import type {
  ZelavisEndpointGroup,
  ZelavisRouteContext,
} from "../../core/index.js";

export type WorkloadType = "function" | "job" | "schedule" | "webhook" | "entity";

export interface WorkloadDefinition {
  id: string;
  projectId: string;
  type: WorkloadType;
  name: string;
  code: string;
  route?: string;
  /** A schedule's cron expression (five fields, or six with seconds first). */
  schedule?: string;
  /**
   * The Tenant a job, schedule or webhook works in: its mailbox, its wakes and its outbox are that Tenant's.
   * A job run may name another.
   */
  tenant?: string;
  /** A webhook's outbound destination: outbox messages with topic `webhook.<name>` in its Tenant are POSTed here. */
  url?: string;
  /**
   * A webhook's shared secret: it verifies the `sha256=<hex>` HMAC of an inbound body and signs an outbound one.
   * Write-only: reads answer `secretSet` instead.
   */
  secret?: string;
  secretSet?: boolean;
  /** The header an inbound webhook carries the signature in; `x-hub-signature-256` (`stripe-signature` when timestamped) unless given. */
  signatureHeader?: string;
  /**
   * How an inbound body is signed: `hmac` (default), a `sha256=<hex>` HMAC of the body, or `timestamped`, a
   * `t=<unix seconds>,v1=<hex>` header whose HMAC covers `<t>.<body>` and whose time must be within five minutes.
   */
  signatureScheme?: "hmac" | "timestamped";
  /** The header an inbound webhook carries the provider's event id in; the body's `id` when absent. */
  eventIdHeader?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkloadRunLog {
  id: string;
  workloadId: string;
  projectId: string;
  status: "completed" | "failed";
  responseStatus?: number;
  output: string;
  createdAt: string;
}

export interface WorkloadsStore {
  list: (filter?: {
    projectId?: string;
    type?: WorkloadType;
  }) => Promise<readonly WorkloadDefinition[]> | readonly WorkloadDefinition[];
  read: (
    id: string,
  ) => Promise<WorkloadDefinition | undefined> | WorkloadDefinition | undefined;
  save: (
    workload: WorkloadDefinition,
  ) => Promise<WorkloadDefinition> | WorkloadDefinition;
  logs: (
    filter?: { projectId?: string; workloadId?: string },
  ) => Promise<readonly WorkloadRunLog[]> | readonly WorkloadRunLog[];
  appendLog: (log: WorkloadRunLog) => Promise<WorkloadRunLog> | WorkloadRunLog;
}

/** What the Workloads routes need from the Project's database: its Tenants' durable entities. */
export type WorkloadsDatabase = Pick<DatabaseRuntimeApi, "forTenant">;

export interface WorkloadsServiceOptions {
  store?: WorkloadsStore;
  /** Where jobs are enqueued and inbound webhooks are saved; without it those routes answer 503. */
  database?: WorkloadsDatabase;
}

export interface WorkloadsApi {
  store: WorkloadsStore;
  database?: WorkloadsDatabase;
  /** Be told when a workload is created or replaced through this service; returns how to stop. */
  subscribe: (listener: () => void) => () => void;
}

const workloadTypes = ["function", "job", "schedule", "webhook", "entity"] as const;

const workloadPluralByType = {
  function: "functions",
  job: "jobs",
  schedule: "schedules",
  webhook: "webhooks",
  entity: "entities",
} as const satisfies Record<WorkloadType, string>;

const defaultFunctionCode = `export default async function handler(ctx) {
  return new Response("Hello from Zelavis Workloads");
}
`;

/**
 * An entity workload's code is the handler of the durable entity type it is named after: one message and the
 * entity's state in, a step out. The step's writes, outbox messages, new state and reply commit with the message.
 */
const defaultEntityCode = `export default async function handle(message, { state, tenant, documents }) {
  const count = (state?.count ?? 0) + 1;
  return { state: { count }, reply: { count } };
}
`;

/**
 * A job, schedule or webhook workload's code is an entity handler too: one message and the state of the entity of
 * its name in, a step out (see `defaultEntityCode`). The message's `payload` is a job's input, a schedule's
 * `{ schedule, fireAt }`, or an inbound webhook's `{ headers, body, eventId, receivedAt }`.
 */
const defaultDurableCode = `export default async function handle(message, { state, tenant, documents }) {
  return { reply: { ok: true } };
}
`;

/** An entity workload's name is the entity type it handles. */
const ENTITY_TYPE = /^[a-z][a-z0-9_-]{0,63}$/;
const checkEntityName = (name: string) => {
  if (!ENTITY_TYPE.test(name)) {
    throw new TypeError("An entity workload is named after its entity type: a letter, then up to 63 letters, digits, `_` or `-`.");
  }
  if (RESERVED_ENTITY_TYPES.has(name)) {
    throw new TypeError(`"${name}" is the entity type of ${name} workloads; an entity workload needs another name.`);
  }
};
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const BODY_LIMIT = 256 * 1024;

export interface WorkloadExecutionResult {
  headers?: Record<string, string>;
  output: string;
  status: "completed" | "failed";
  responseStatus?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function now() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function slugifyName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readBodyObject(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new TypeError("Request body must be a JSON object.");
  }

  return body;
}

function readString(
  body: Record<string, unknown>,
  key: string,
  fallback?: string,
) {
  const value = body[key];

  if (value == null) {
    return fallback;
  }

  if (typeof value !== "string") {
    throw new TypeError(`${key} must be a string.`);
  }

  return value;
}

function readBoolean(
  body: Record<string, unknown>,
  key: string,
  fallback: boolean,
) {
  const value = body[key];

  if (value == null) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new TypeError(`${key} must be a boolean.`);
  }

  return value;
}

/** A string field that stays as it was when absent and is cleared by an empty string. */
function readOptional(body: Record<string, unknown>, key: string, existing?: string) {
  const value = body[key];
  if (value == null) return existing;
  if (typeof value !== "string") throw new TypeError(`${key} must be a string.`);
  return value === "" ? undefined : value;
}

/** The fields durable workloads add, checked against the kind of workload they belong to. */
function readDurableFields(body: Record<string, unknown>, type: WorkloadType, existing?: WorkloadDefinition) {
  const tenant = readOptional(body, "tenant", existing?.tenant);
  if (tenant !== undefined && !isValidTenantId(tenant)) throw new TypeError("tenant is not a valid Tenant id.");
  if (tenant !== undefined && type === "function") throw new TypeError("tenant applies to jobs, schedules, webhooks and entities.");
  const schedule = readOptional(body, "schedule", existing?.schedule);
  if (type === "schedule" && schedule !== undefined && !isCronExpression(schedule)) {
    throw new TypeError("schedule must be a cron expression: minute hour day month weekday (seconds first when six fields).");
  }
  const url = readOptional(body, "url", existing?.url);
  const secret = readOptional(body, "secret", existing?.secret);
  const signatureHeader = readOptional(body, "signatureHeader", existing?.signatureHeader)?.toLowerCase();
  const schemeGiven = readOptional(body, "signatureScheme", existing?.signatureScheme);
  if (schemeGiven !== undefined && schemeGiven !== "hmac" && schemeGiven !== "timestamped") {
    throw new TypeError('signatureScheme is "hmac" or "timestamped".');
  }
  const signatureScheme: "hmac" | "timestamped" | undefined = schemeGiven;
  const eventIdHeader = readOptional(body, "eventIdHeader", existing?.eventIdHeader)?.toLowerCase();
  if ((url !== undefined || secret !== undefined || signatureHeader !== undefined || signatureScheme !== undefined || eventIdHeader !== undefined) && type !== "webhook") {
    throw new TypeError("url, secret, signatureHeader, signatureScheme and eventIdHeader apply to webhook workloads.");
  }
  if (url !== undefined) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new TypeError("url must be an absolute http or https URL."); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new TypeError("url must be an absolute http or https URL.");
    if (parsed.username !== "" || parsed.password !== "") throw new TypeError("url carries no credentials; use a secret.");
  }
  if (secret !== undefined && (secret.length < 16 || secret.length > 512)) throw new TypeError("secret is 16 to 512 characters.");
  for (const [name, header] of [["signatureHeader", signatureHeader], ["eventIdHeader", eventIdHeader]] as const) {
    if (header !== undefined && !HEADER_NAME.test(header)) throw new TypeError(`${name} is an HTTP header name.`);
  }
  return {
    ...(tenant === undefined ? {} : { tenant }),
    ...(schedule === undefined ? {} : { schedule }),
    ...(url === undefined ? {} : { url }),
    ...(secret === undefined ? {} : { secret }),
    ...(signatureHeader === undefined ? {} : { signatureHeader }),
    ...(signatureScheme === undefined ? {} : { signatureScheme }),
    ...(eventIdHeader === undefined ? {} : { eventIdHeader }),
  };
}

function readWorkloadType(value: unknown): WorkloadType {
  if (
    typeof value === "string" &&
    workloadTypes.includes(value as WorkloadType)
  ) {
    return value as WorkloadType;
  }

  throw new TypeError("type must be function, job, schedule, webhook, or entity.");
}

function jsonError(error: unknown, status = 400) {
  // Shared policy: 4xx keeps the caller-facing message, 5xx is genericized
  // unless it is a typed domain error.
  const tag = (error as { readonly _tag?: unknown } | null)?._tag;
  return createJsonErrorResponse(tag === "MailboxFull" ? 409 : tag === "TenantMoving" ? 503 : status, error);
}

/** A definition as clients read it: the secret is write-only. */
export function publicWorkload(workload: WorkloadDefinition): WorkloadDefinition {
  const { secret, ...rest } = workload;
  return secret === undefined ? rest : { ...rest, secretSet: true };
}

function normalizeRoutePath(path: string | undefined) {
  if (!path) {
    return "/";
  }

  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") {
    return "/";
  }

  return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function toHeaderRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of headers.entries()) {
    result[key] = value;
  }

  return result;
}

function normalizeExecutionValue(
  value: unknown,
): Promise<WorkloadExecutionResult> {
    return present(Effect.gen(function* (): Effect.fn.Return<WorkloadExecutionResult, IntegrationFailure> {
  if (value instanceof Response) {
    return {
      status: value.ok ? "completed" : "failed",
      responseStatus: value.status,
      headers: toHeaderRecord(value.headers),
      output: (yield* integrationValue(value.text())),
    };
  }

  if (value === undefined) {
    return {
      status: "completed",
      output: "",
    };
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return {
      status: "completed",
      output: String(value ?? ""),
    };
  }

  return {
    status: "completed",
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    output: JSON.stringify(value),
  };
}));
  }

function executeTrustedJavaScriptWorkload(
  workload: WorkloadDefinition,
  request: Request,
): Promise<WorkloadExecutionResult> {
    return present(Effect.gen(function* (): Effect.fn.Return<WorkloadExecutionResult, IntegrationFailure> {
  if (workload.type !== "function") {
    throw new TypeError("Only function workloads can be run by the JavaScript runner.");
  }

  const module = ((yield* integrationValue(import(createModuleDataUrl(workload))))) as {
    default?: unknown;
    handler?: unknown;
  };
  const handler = module.default ?? module.handler;

  if (typeof handler !== "function") {
    throw new TypeError(
      "Function workloads must export a default function or named handler function.",
    );
  }

  return (yield* integrationValue(normalizeExecutionValue(
    (yield* integrationValue(handler({
      env: {},
      projectId: workload.projectId,
      request,
      route: workload.route,
      workload,
    }))),
  )));
}));
  }

function createSeedWorkloads(): WorkloadDefinition[] {
  const timestamp = now();

  return [
    {
      id: "fn_hello_world",
      projectId: "default",
      type: "function",
      name: "hello-world",
      route: "/api/hello",
      code: defaultFunctionCode,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

export function createMemoryWorkloadsStore(
  seed: readonly WorkloadDefinition[] = createSeedWorkloads(),
): WorkloadsStore {
  const workloads = new Map(seed.map((workload) => [workload.id, workload]));
  const runLogs: WorkloadRunLog[] = [];

  return {
    list(filter = {}) {
      return [...workloads.values()]
        .filter((workload) =>
          filter.projectId ? workload.projectId === filter.projectId : true,
        )
        .filter((workload) => (filter.type ? workload.type === filter.type : true))
        .sort((left, right) => left.name.localeCompare(right.name));
    },
    read(id) {
      return workloads.get(id);
    },
    save(workload) {
      workloads.set(workload.id, workload);
      return workload;
    },
    logs(filter = {}) {
      return runLogs
        .filter((log) =>
          filter.projectId ? log.projectId === filter.projectId : true,
        )
        .filter((log) =>
          filter.workloadId ? log.workloadId === filter.workloadId : true,
        )
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    },
    appendLog(log) {
      runLogs.unshift(log);
      return log;
    },
  };
}

function readProjectId(query: URLSearchParams) {
  return query.get("projectId") || "default";
}

function readTypeFromQuery(query: URLSearchParams) {
  const type = query.get("type");
  return type ? readWorkloadType(type) : undefined;
}

function readTypeFromPlural(value: unknown): WorkloadType {
  if (value === "functions") {
    return "function";
  }
  if (value === "jobs") {
    return "job";
  }
  if (value === "schedules") {
    return "schedule";
  }
  if (value === "webhooks") {
    return "webhook";
  }

  throw new TypeError("Unknown workload menu section.");
}

function createWorkload(
  store: WorkloadsStore,
  body: unknown,
): Promise<WorkloadDefinition> {
    return present(Effect.gen(function* (): Effect.fn.Return<WorkloadDefinition, IntegrationFailure> {
  const input = readBodyObject(body);
  const type = readWorkloadType(input.type);
  const name = slugifyName(readString(input, "name", "") ?? "");

  if (!name) {
    throw new TypeError("name is required.");
  }
  if (type === "entity") checkEntityName(name);

  const timestamp = now();
  const workload: WorkloadDefinition = {
    id: createId(type === "function" ? "fn" : type),
    projectId: slugifyName(readString(input, "projectId", "default") ?? "default"),
    type,
    name,
    code: readString(input, "code", type === "entity" ? defaultEntityCode : type === "function" ? defaultFunctionCode : defaultDurableCode) ?? defaultFunctionCode,
    route: readString(input, "route"),
    ...readDurableFields(input, type),
    enabled: readBoolean(input, "enabled", true),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return publicWorkload(yield* integrationValue(store.save(workload)));
}));
  }

function updateWorkload(
  store: WorkloadsStore,
  id: string,
  body: unknown,
): Promise<WorkloadDefinition> {
    return present(Effect.gen(function* (): Effect.fn.Return<WorkloadDefinition, IntegrationFailure> {
  const existing = (yield* integrationValue(store.read(id)));
  if (!existing) {
    throw new TypeError("Workload not found.");
  }

  const input = readBodyObject(body);
  const name = slugifyName(readString(input, "name", existing.name) ?? existing.name);
  if (existing.type === "entity") checkEntityName(name);
  // Cleared fields are dropped, not kept as they were: start from the definition without the ones that can clear.
  const { tenant: _tenant, schedule: _schedule, url: _url, secret: _secret, signatureHeader: _signature, signatureScheme: _scheme, eventIdHeader: _eventId, secretSet: _set, ...kept } = existing;
  const next: WorkloadDefinition = {
    ...kept,
    name,
    code: readString(input, "code", existing.code) ?? existing.code,
    route: readString(input, "route", existing.route),
    ...readDurableFields(input, existing.type, existing),
    enabled: readBoolean(input, "enabled", existing.enabled),
    updatedAt: now(),
  };

  return publicWorkload(yield* integrationValue(store.save(next)));
}));
  }

function runWorkload(
  store: WorkloadsStore,
  workload: WorkloadDefinition,
): Promise<WorkloadRunLog> {
  return present(Effect.gen(function* (): Effect.fn.Return<WorkloadRunLog, IntegrationFailure> {
    const timestamp = now();
    const request = new Request(
      `http://zelavis.local${normalizeRoutePath(workload.route)}`,
    );

    const log = yield* integration(() => executeTrustedJavaScriptWorkload(workload, request)).pipe(
      Effect.map((result): WorkloadRunLog => ({
        id: createId("run"),
        workloadId: workload.id,
        projectId: workload.projectId,
        status: result.status,
        responseStatus: result.responseStatus,
        output: result.output,
        createdAt: timestamp,
      })),
      Effect.catch((failure) => {
        const error = unwrapFailure(failure);
        return Effect.succeed<WorkloadRunLog>({
          id: createId("run"),
          workloadId: workload.id,
          projectId: workload.projectId,
          status: "failed",
          output: error instanceof Error ? error.message : String(error),
          createdAt: timestamp,
        });
      }),
    );

    return yield* integration(() => store.appendLog(log));
  }));
}

function enqueueJob(database: WorkloadsDatabase | undefined, workload: WorkloadDefinition, body: unknown) {
  return present(Effect.gen(function* () {
    if (database === undefined) throw new TypeError("This runtime has no database to keep jobs in.");
    const input = isRecord(body) ? body : {};
    const tenant = readString(input, "tenantId") ?? workload.tenant;
    if (tenant === undefined) throw new TypeError("Name a Tenant: tenantId in the request, or a tenant on the job.");
    if (!isValidTenantId(tenant)) throw new TypeError("tenantId is not a valid Tenant id.");
    if (input.input != null && !isRecord(input.input)) throw new TypeError("input must be a JSON object.");
    const primaryKey = readString(input, "primaryKey");
    const deliverAt = readString(input, "deliverAt");
    return yield* integration(() => database.forTenant(tenant).entities.send({
      type: JOB_ENTITY, id: workload.name, tag: "run", payload: (input.input ?? {}) as Record<string, never>,
      ...(primaryKey === undefined ? {} : { primaryKey }), ...(deliverAt === undefined ? {} : { deliverAt }),
    }));
  }));
}

/**
 * An inbound webhook: verified, then saved in its Tenant's mailbox keyed by the provider's event id, and only then
 * answered. A provider's retry of the same event finds it already kept (`duplicate`), so a 2xx means "kept", never
 * "will be kept". A mailbox that cannot take it answers 503 with `retry-after`, which providers retry.
 */
function receiveWebhook(database: WorkloadsDatabase | undefined, store: WorkloadsStore, projectId: string, name: string, request: Request) {
  return present(Effect.gen(function* () {
    const workload = (yield* integrationValue(store.list({ projectId, type: "webhook" }))).find((entry) => entry.enabled && entry.name === name);
    if (workload === undefined) return { status: 404, body: { error: "Webhook not found." } };
    if (database === undefined) return { status: 503, body: { error: "This runtime has no database to keep webhooks in." } };
    if (workload.tenant === undefined) return { status: 409, body: { error: "This webhook has no tenant to keep events in." } };
    const length = Number(request.headers.get("content-length") ?? 0);
    if (Number.isFinite(length) && length > BODY_LIMIT) return { status: 413, body: { error: `A webhook body is at most ${BODY_LIMIT} bytes.` } };
    const text = yield* integration(() => request.text());
    if (text.length > BODY_LIMIT) return { status: 413, body: { error: `A webhook body is at most ${BODY_LIMIT} bytes.` } };
    const timestamped = workload.signatureScheme === "timestamped";
    const signatureHeader = workload.signatureHeader ?? (timestamped ? TIMESTAMPED_SIGNATURE_HEADER : DEFAULT_SIGNATURE_HEADER);
    if (workload.secret !== undefined) {
      const given = request.headers.get(signatureHeader);
      const genuine = timestamped
        ? yield* verifyTimestampedSignature(workload.secret, text, given, Date.now())
        : yield* verifySignature(workload.secret, text, given);
      if (!genuine) return { status: 401, body: { error: "The signature does not match." } };
    }
    let parsed: unknown;
    try { parsed = text === "" ? {} : JSON.parse(text); } catch { parsed = undefined; }
    const eventId = eventIdOf(workload, request.headers, parsed);
    if (eventId === undefined) return { status: 400, body: { error: "The event has no id to keep it by: name the header in eventIdHeader, or send a body with an id." } };
    const body = isRecord(parsed) ? { body: parsed } : { raw: text };
    const sent = yield* integration(() => database.forTenant(workload.tenant!).entities.send({
      type: WEBHOOK_ENTITY, id: workload.name, tag: "received", primaryKey: eventId,
      payload: JSON.parse(JSON.stringify({ eventId, receivedAt: now(), headers: keptHeaders(request.headers, signatureHeader), ...body })) as Record<string, never>,
    })).pipe(Effect.catch((failure) => {
      const error = unwrapFailure(failure) as { readonly _tag?: string };
      return error._tag === "MailboxFull" || error._tag === "TenantMoving"
        ? Effect.succeed({ unavailable: true as const })
        : Effect.fail(failure);
    }));
    if ("unavailable" in sent) return { status: 503, headers: { "retry-after": "30" }, body: { error: "The webhook's mailbox cannot take the event now; send it again." } };
    return { status: 202, body: { received: true, duplicate: sent.duplicate, messageKey: sent.message.messageKey } };
  }));
}

function findHttpFunction(
  store: WorkloadsStore,
  projectId: string,
  path: string,
) {
    return present(Effect.gen(function* () {
  const normalizedPath = normalizeRoutePath(path);
  const workloads = (yield* integrationValue(store.list({
    projectId,
    type: "function",
  })));

  return (yield* integrationValue(workloads.find(
    (workload) =>
      workload.enabled && normalizeRoutePath(workload.route) === normalizedPath,
  )));
}));
  }

function runHttpFunction(
  store: WorkloadsStore,
  workload: WorkloadDefinition,
  request: Request,
) {
  return present(Effect.gen(function* () {
    const timestamp = now();

    return yield* Effect.gen(function* () {
      const result = yield* integration(() => executeTrustedJavaScriptWorkload(workload, request));
      yield* integration(() => store.appendLog({
        id: createId("run"),
        workloadId: workload.id,
        projectId: workload.projectId,
        status: result.status,
        responseStatus: result.responseStatus,
        output: result.output,
        createdAt: timestamp,
      }));

      return {
        status: result.responseStatus ?? (result.status === "failed" ? 500 : 200),
        headers: result.headers,
        body: result.output,
      } as HttpFunctionResponse;
    }).pipe(Effect.catch((failure) => Effect.gen(function* () {
      const error = unwrapFailure(failure);
      const output = error instanceof Error ? error.message : String(error);
      yield* integration(() => store.appendLog({
        id: createId("run"),
        workloadId: workload.id,
        projectId: workload.projectId,
        status: "failed",
        output,
        createdAt: timestamp,
      }));

      return {
        status: 500,
        body: {
          error: output,
        },
      } as HttpFunctionResponse;
    })));
  }));
}

interface HttpFunctionResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body: unknown;
}

function createHttpFunctionRoute(
  store: WorkloadsStore,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
) {
  return {
    id: `workloads.http.${method.toLowerCase()}`,
    spec: {
      operationId: `invokeHttpWorkload${method[0]}${method.slice(1).toLowerCase()}`,
      summary: "Invoke an HTTP workload",
      description:
        "Dispatches to the HTTP workload a Project has registered for this path.",
      tags: ["workloads"],
      pathParams: {
        projectId: {
          type: "string" as const,
          required: true,
          description: "The Project owning the workload.",
        },
        path: {
          type: "string" as const,
          required: true,
          description: "The workload's registered path.",
        },
      },
      responses: {
        200: { description: "The workload's response" },
        404: { description: "No workload is registered for that path" },
      },
    },
    method,
    path: "/http/:projectId/*path",
    handler: ({
      params,
      request,
    }: ZelavisRouteContext<WorkloadsApi>) => present(Effect.gen(function* () {
      const projectId = params.projectId || "default";
      const requestedPath = normalizeRoutePath(params.path);
      const workload = yield* integrationValue(findHttpFunction(store, projectId, requestedPath));

      if (!workload) {
        return {
          status: 404,
          body: {
            error: "Function route not found.",
          },
        };
      }

      return yield* integrationValue(runHttpFunction(store, workload, request));
    }).pipe(Effect.catchCause((cause) => Effect.succeed(jsonError(unwrapFailure(Cause.squash(cause))))))),
  };
}

function route<T>(
  handler: (context: ZelavisRouteContext<WorkloadsApi>) => Promise<T>,
) {
  return (context: ZelavisRouteContext<WorkloadsApi>) => present(
    integration(() => handler(context)).pipe(
      Effect.map((body) => ({
        status: 200,
        body,
      })),
      Effect.catchCause((cause) => Effect.succeed(jsonError(unwrapFailure(Cause.squash(cause))))),
    ),
  );
}


export function workloadsEndpointGroup(
  options: WorkloadsServiceOptions = {},
): ZelavisEndpointGroup<WorkloadsApi> {
  const store = options.store ?? createMemoryWorkloadsStore();
  const listeners = new Set<() => void>();
  const changed = () => { for (const listener of listeners) listener(); };
  const service: WorkloadsApi = {
    store,
    ...(options.database === undefined ? {} : { database: options.database }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };

  return {
    id: "workloads",
    basePath: "/workloads",
    context: service,
    origin: { type: "subsystem", subsystem: "workloads" },
    api: {
      v1: [
        {
          id: "workloads.health",
          spec: {
            operationId: "getWorkloadsHealth",
            summary: "Report workloads health",
            tags: ["workloads"],
            responses: {
              200: { description: "Health" },
            },
          },
          method: "GET",
          path: "/health",
          handler: route(() => present(integration(() => { status: "ready" }))),
        },
        {
          id: "workloads.menu",
          spec: {
            operationId: "listWorkloadsMenu",
            summary: "List workloads as dashboard menu items",
            tags: ["workloads"],
            responses: {
              200: { description: "Menu items" },
            },
          },
          method: "GET",
          path: "/menu/:section",
          access: { permissions: ["workloads.view"] },
          handler: route(({ params, query }) => present(Effect.gen(function* () {
            const type = readTypeFromPlural(params.section);
            const projectId = readProjectId(query);
            const workloads = (yield* integrationValue(store.list({ projectId, type })));
            return {
              items: workloads.map((workload) => ({
                title: workload.name,
                path: `/workloads/${workloadPluralByType[workload.type]}/${workload.id}`,
                pageLabel: "Workloads",
              })),
            };
          }))),
        },
        {
          id: "workloads.list",
          spec: {
            operationId: "listWorkloads",
            summary: "List workloads",
            tags: ["workloads"],
            responses: {
              200: { description: "Workloads" },
            },
          },
          method: "GET",
          path: "/",
          access: { permissions: ["workloads.view"] },
          handler: route(({ query }) => present(Effect.gen(function* () {
    return {
            workloads: (yield* integrationValue(store.list({
              projectId: readProjectId(query),
              type: readTypeFromQuery(query),
            }))).map(publicWorkload),
          };
  }))),
        },
        {
          id: "workloads.create",
          spec: {
            operationId: "createWorkload",
            summary: "Create a workload",
            tags: ["workloads"],
            responses: {
              201: { description: "Workload created" },
              400: { description: "Invalid workload" },
            },
          },
          method: "POST",
          path: "/",
          access: { permissions: ["workloads.manage"] },
          handler: ({ body }) => present(
            integration(() => createWorkload(store, body)).pipe(
              Effect.tap(() => Effect.sync(changed)),
              Effect.map((created) => ({
                status: 201,
                body: created,
              })),
              Effect.catchCause((cause) => Effect.succeed(jsonError(unwrapFailure(Cause.squash(cause))))),
            ),
          ),
        },
        {
          id: "workloads.read",
          spec: {
            operationId: "getWorkload",
            summary: "Read one workload",
            tags: ["workloads"],
            responses: {
              200: { description: "Workload" },
              404: { description: "No such workload" },
            },
          },
          method: "GET",
          path: "/:id",
          access: { permissions: ["workloads.view"] },
          handler: route(({ params }) => present(Effect.gen(function* () {
            const workload = (yield* integrationValue(store.read(params.id)));
            if (!workload) {
              throw new TypeError("Workload not found.");
            }
            return publicWorkload(workload);
          }))),
        },
        {
          id: "workloads.update",
          spec: {
            operationId: "updateWorkload",
            summary: "Replace a workload definition",
            tags: ["workloads"],
            responses: {
              200: { description: "Workload updated" },
              404: { description: "No such workload" },
            },
          },
          method: "PUT",
          path: "/:id",
          access: { permissions: ["workloads.manage"] },
          handler: route(({ params, body }) =>
            present(integration(() => updateWorkload(store, params.id, body)).pipe(Effect.tap(() => Effect.sync(changed)))),
          ),
        },
        {
          id: "workloads.run",
          spec: {
            operationId: "runWorkload",
            summary: "Run a workload now",
            description:
              "Runs a function now. For a job it enqueues a run instead: the body may name `tenantId` (the job's own Tenant when omitted), `input` (the JSON object the job's code receives as the message payload), a `primaryKey` that makes a resend the same run, and `deliverAt` (ISO 8601) to hold the run until then. The answer is `{ message, duplicate }`; the run is kept until the job's code has handled it, retried with growing pauses.",
            tags: ["workloads"],
            responses: {
              200: { description: "Run started" },
              404: { description: "No such workload" },
            },
          },
          method: "POST",
          path: "/:id/run",
          access: { permissions: ["workloads.manage"] },
          handler: route(({ params, body }) => present(Effect.gen(function* () {
            const workload = (yield* integrationValue(store.read(params.id)));
            if (!workload) {
              throw new TypeError("Workload not found.");
            }
            // A job is not run in the request: the run is kept in its Tenant's mailbox until its code has handled it.
            if (workload.type === "job") return (yield* integrationValue(enqueueJob(options.database, workload, body)));
            return (yield* integrationValue(runWorkload(store, workload)));
          }))),
        },
        {
          id: "workloads.webhooks.receive",
          spec: {
            operationId: "receiveWebhook",
            summary: "Receive an inbound webhook",
            description:
              "Verifies the webhook's HMAC signature when it has a secret, saves the event in its Tenant's mailbox keyed by the provider's event id, and only then answers 202. A provider's retry of an event already kept answers 202 with `duplicate: true`. 401 when the signature does not match, 400 when the event has no id, 413 over 256 KiB, 503 with `retry-after` when the mailbox is full.",
            tags: ["workloads"],
            pathParams: {
              projectId: { type: "string" as const, required: true, description: "The Project owning the webhook." },
              name: { type: "string" as const, required: true, description: "The webhook workload's name." },
            },
            responses: {
              202: { description: "{ received, duplicate, messageKey }" },
              401: { description: "The signature does not match" },
              404: { description: "No such webhook" },
              503: { description: "Not kept; send it again" },
            },
          },
          method: "POST" as const,
          path: "/webhooks/:projectId/:name",
          handler: ({ params, request }: ZelavisRouteContext<WorkloadsApi>) => present(
            integration(() => receiveWebhook(options.database, store, params.projectId || "default", params.name!, request)).pipe(
              Effect.catchCause((cause) => Effect.succeed(jsonError(unwrapFailure(Cause.squash(cause))))),
            ),
          ),
        },
        ...(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((method) =>
          createHttpFunctionRoute(store, method),
        ),
        {
          id: "workloads.logs",
          spec: {
            operationId: "getWorkloadLogs",
            summary: "Read recent workload logs",
            tags: ["workloads"],
            responses: {
              200: { description: "Log lines" },
            },
          },
          method: "GET",
          path: "/logs",
          access: { permissions: ["workloads.logs.read"] },
          handler: route(({ query }) => present(Effect.gen(function* () {
    return {
            logs: (yield* integrationValue(store.logs({
              projectId: readProjectId(query),
              workloadId: query.get("workloadId") || undefined,
            }))),
          };
  }))),
        },
      ],
    },
  };
}
