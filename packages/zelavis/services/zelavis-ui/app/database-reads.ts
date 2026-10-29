import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { createHash } from "node:crypto";
import type { ServerRequestContext } from "fuzor/server";
import { API_PREFIX } from "./mount.ts";
import { pageNumber, parseFilter, parseSort } from "./grids/model.ts";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
/** The public answer the Database workspace component renders: everything here is visible to the browser. */
export type DatabaseWorkspace = Record<string, unknown>;

/**
 * Reads one Project's Database workspace from the Platform with the caller's own session. It runs only on the server, from the
 * component's `<script server>`; every request it makes is authenticated and authorized by Zelavis itself.
 */
export const readDatabaseWorkspace = (context: Pick<ServerRequestContext, "request" | "url" | "params" | "signal">): Promise<DatabaseWorkspace> => Effect.runPromise(Effect.gen(function* () {
    const signal = context.signal;
    // Inside a Platform the dashboard calls it in-process (`src/dashboard-service.ts` hands over its `fetch`), so no
    // address is guessed and no caller's Host header chooses an upstream. Only the dev server, which runs apart from a
    // Platform, reaches it over the network, at the operator-configured origin.
    const platform = (globalThis as { __zelavisDashboardPlatform?: { fetch(request: Request): Promise<Response> } }).__zelavisDashboardPlatform;
    const origin = platform ? new URL(context.request.url).origin : new URL(process.env.ZELAVIS_DEV_SERVER ?? "http://127.0.0.1:3000").origin;
    const send = (url: URL, init: RequestInit) => platform ? platform.fetch(new Request(url, init)) : fetch(url, init);
    let requiresLogin = false;
    const projectId = context.params.projectId;
    const read = Effect.fn("new-ui.server.read")(function*(path: string, body?: unknown) {
      if (!path.startsWith(API_PREFIX) || path.includes("..")) throw new Error("Invalid dashboard API mount");
      const response = yield* Effect.tryPromise({ try: operationSignal => send(new URL(path, origin), { signal: AbortSignal.any([signal, operationSignal]), method: body === undefined ? "GET" : "POST", redirect: "error", headers: {
        accept: "application/json", origin,
        ...(context.request.headers.get("cookie") ? { cookie: context.request.headers.get("cookie")! } : {}),
        ...(context.request.headers.get("authorization") ? { authorization: context.request.headers.get("authorization")! } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), catch: error => error });
      if (!response.ok) {
        requiresLogin ||= response.status === 401;
        // The database explains a refused query (an unindexed field, an unknown operator); say so instead of a bare status.
        const refusal = response.status === 400 || response.status === 409 || response.status === 422 ? object(yield* Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined))).error : undefined;
        throw new Error(response.status === 401 ? "Sign in to open this project's database." : typeof refusal === "string" ? `The database refused this query: ${refusal}` : `Database request failed (${response.status}).`);
      }
      if (!response.body) return yield* Effect.fail(new Error("Database response has no body"));
      return yield* Effect.acquireUseRelease(
        Effect.sync(() => response.body!.getReader()),
        reader => Effect.gen(function* () {
          const decoder = new TextDecoder(); let text = "", bytes = 0;
          while (true) {
            const part = yield* Effect.tryPromise({ try: () => reader.read(), catch: error => error });
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 8 * 1024 * 1024) return yield* Effect.fail(new Error("Dashboard response exceeds the loaded-page limit"));
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          return yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: error => error });
        }),
        reader => Effect.tryPromise({ try: () => reader.cancel(), catch: error => error }).pipe(Effect.catch(error => Effect.logWarning("Dashboard stream cleanup failed", error)), Effect.ensuring(Effect.sync(() => reader.releaseLock())))
      );
    });
    return yield* Effect.gen(function* () {
      const control = object(yield* read(`${API_PREFIX}v1/runtime/config`));
      const base = String(object(control.api).basePath);
      if (!projectId) throw new Error("A database view requires a project ID");
      const projects: Record<string, unknown>[] = array(object(yield* read(`${base}/runtime/projects`)).projects).map(value => { const project = object(value); return { ...project, status: object(project.runtime).status }; });
      const project = projects.find(entry => entry.id === projectId);
      if (!project) throw new Error("Project not found");
      if (project.status !== "running") throw new Error("Start this project to open its database");
      const proxy = `${base}/runtime/projects/${encodeURIComponent(projectId)}/proxy`;
      const runtime = object(yield* read(`${proxy}${API_PREFIX}v1/runtime/config`));
      if (object(object(runtime.capabilities).database).available !== true) throw new Error("This project does not expose a Zelavis database");
      const projectBase = String(object(runtime.api).basePath);
      if (!projectBase.startsWith(API_PREFIX)) throw new Error("Invalid project API mount");
      const apiBase = proxy + projectBase;
      const scoped = { ...runtime, api: { basePath: apiBase } };
      const menu = yield* read(`${apiBase}/database/menu/tables`);
      const tenant = context.url.searchParams.get("databaseTenant") ?? "zelavis-app";
      const collection = context.url.searchParams.get("databaseTable") ?? "";
      const systemView = context.url.searchParams.get("databaseSystemView") ?? "";
      const after = context.url.searchParams.get("databaseAfter") ?? undefined;
      const limit = Math.max(1, pageNumber(context.url.searchParams.get("databaseLimit"), 25, 250));
      // A Tenant keeps its history after every collection is dropped, so the list can name Tenants with no tables.
      const tenants = array(object(yield* read(`${apiBase}/database/tenants`).pipe(Effect.catchCause(() => Effect.succeed({})))).tenants).filter((value): value is string => typeof value === "string");
      let choices = array(object(menu).items);
      if (context.url.pathname.includes("/content") && tenant) choices = array(object(yield* read(`${apiBase}/database/documents/collections?tenantId=${encodeURIComponent(tenant)}`)).collections).filter(value => object(value).surface === "content-studio").map(value => ({ title: object(value).name, search: { databaseTenant: tenant, databaseTable: object(value).name } }));
      const schemaPanel = Boolean(tenant && collection && !systemView && context.url.searchParams.get("databasePanel") === "schema");
      const schemas = tenant && collection && !systemView ? array(object(yield* read(`${apiBase}/database/schemas/${encodeURIComponent(collection)}?tenantId=${encodeURIComponent(tenant)}`)).schemas) : [];
      let records: unknown[] = [];
      let queryError: string | undefined, next: string | undefined;
      const where = parseFilter(context.url.searchParams.get("databaseWhere")), order = parseSort(context.url.searchParams.get("databaseSort"));
      if (tenant && systemView) records = array(object(yield* read(`${apiBase}/database/maintenance/system/views/${encodeURIComponent(systemView)}?tenantId=${encodeURIComponent(tenant)}&limit=50`)).rows);
      else if (tenant && collection && !schemaPanel) {
        const query = { tenantId: tenant, limit, ...(after ? { after } : {}), ...(where ? { where: [where] } : {}), ...(order ? { orderBy: [order] } : {}) };
        // A refused query (for example an unindexed field) keeps the workspace open and says why; auth and transport failures still end the view.
        records = yield* read(`${apiBase}/database/documents/${encodeURIComponent(collection)}/page`, query).pipe(
          Effect.map(result => { const page = object(result); next = typeof page.next === "string" ? page.next : undefined; return array(page.documents); }),
          Effect.catchCause(cause => { const error = Cause.squash(cause); if (error instanceof Error && error.message.startsWith("The database refused")) { queryError = error.message; return Effect.succeed([] as unknown[]); } return Effect.failCause(cause); }),
        );
      }
      const draftScope = createHash("sha256").update(context.request.headers.get("cookie") ?? "").update(context.request.headers.get("authorization") ?? "").digest("hex");
      const recordsJson = JSON.stringify(records);
      // Public answers are bounded (2 MiB); a page of very large documents says so instead of failing the whole view.
      const tooLarge = recordsJson.length > MAX_RECORDS_JSON;
      return { schemaPanel, schemasJson: JSON.stringify(schemas), selectedSchemaVersion: context.url.searchParams.get("schemaVersion") ?? "", draftScope, projectId, apiBase, tenant, collection, systemView, after: after ?? "", next: next ?? "", limit, readonly: Boolean(systemView), ...(queryError || tooLarge ? { queryError: queryError ?? "This page of records is too large to load at once. Choose a smaller page size." } : {}), recordsJson: tooLarge ? "[]" : recordsJson, choicesJson: JSON.stringify(choices), tenantsJson: JSON.stringify(tenants), navigationJson: JSON.stringify({ project, projects, runtime: scoped, menu }) } satisfies DatabaseWorkspace;
    }).pipe(Effect.catchCause(cause => {
      const error = Cause.squash(cause);
      if (signal.aborted) return Effect.fail(error);
      return Effect.succeed({ error: error instanceof Error ? error.message : "Could not open the database", signin: requiresLogin } satisfies DatabaseWorkspace);
    }));
}).pipe(Effect.timeout("30 seconds")), { signal: context.signal });
const MAX_RECORDS_JSON = 1_500_000;
