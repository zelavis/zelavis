import { Data, Effect, Schema } from "effect";
import type { EcommerceApi } from "@zelavis/ecommerce";
import type { ZelavisRouteContext, ZelavisRouteResponse, ZelavisServerRoute } from "zelavis/core";
import type { DatabaseRuntimeApi } from "zelavis/db";
import type { ZelavisServiceSetupCoreContext } from "zelavis/service";

export class HostingError extends Data.TaggedError("HostingError")<{
  readonly status: number;
  readonly code: string;
  readonly message: string;
}> {}

export const hostingError = (status: number, code: string, message: string) =>
  new HostingError({ status, code, message });

export type Commerce = () => Effect.Effect<EcommerceApi, HostingError>;

export const invalid = (message: string) => hostingError(400, "invalid_hosting_request", message);
export const unavailable = () => hostingError(503, "hosting_not_configured", "Configure Hosting Provider before accepting subscriptions.");
export const revisionConflict = () => hostingError(409, "hosting_revision_conflict", "The record changed. Reload it and try again.");
export const platformFailure = (status: number) => hostingError(502, "platform_call_failed", `Platform operation returned status ${status}.`);

export const subscriptionCollection = "hosting_subscriptions";
export const dateString = Schema.String.check(Schema.makeFilter(value =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value));
export const decode = <I, A>(parse: (input: I) => A, value: I, message: string) =>
  Effect.try({ try: () => parse(value), catch: () => invalid(message) });
export const strict = { onExcessProperty: "error" } as const;

export function isDatabase(value: unknown): value is DatabaseRuntimeApi {
  return typeof value === "object" && value !== null && "forTenant" in value && typeof value.forTenant === "function";
}

type Documents = ReturnType<DatabaseRuntimeApi["forTenant"]>["documents"];
export type Transaction = Parameters<Parameters<Documents["transaction"]>[0]>[0];
type Fields = Parameters<Transaction["insert"]>[0]["data"];

const databaseFailure = (error: unknown) => {
  if (error instanceof HostingError) return error;
  if (typeof error === "object" && error !== null && "_tag" in error &&
      ["DocumentConflict", "TransactionConflict"].includes(String(error._tag))) return revisionConflict();
  return hostingError(503, "hosting_storage_unavailable", "Hosting storage is temporarily unavailable.");
};
export const dbCall = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: databaseFailure });

export function table<A>(collection: string, parse: (data: unknown) => A) {
  const read = (data: unknown) => Effect.try({ try: () => parse(data), catch: databaseFailure });
  return { collection, read };
}
type Table<A> = ReturnType<typeof table<A>>;

export function hostingStore(database: DatabaseRuntimeApi) {
  const { documents } = database.forTenant("service:@zelavis/hosting");
  const transaction = <A>(body: (tx: Transaction) => Effect.Effect<A, HostingError>) =>
    dbCall(() => documents.transaction(tx => Effect.runPromise(body(tx))));
  const get = <A>(source: Table<A>, id: string, tx?: Transaction) => Effect.gen(function* () {
    const key = { collection: source.collection, id };
    const record = yield* dbCall(() => tx ? tx.get(key) : documents.findById(key));
    return record ? yield* source.read(record.data) : undefined;
  });
  const put = (tx: Transaction, collection: string, id: string, data: Fields, exists: boolean) =>
    exists ? dbCall(() => tx.update({ collection, id, data, mode: "replace" })) :
      dbCall(() => tx.insert({ collection, id, data })).pipe(Effect.asVoid);
  const ensure = (collection: string, columns?: readonly string[]) => Effect.gen(function* () {
    if (!(yield* dbCall(() => documents.collectionExists(collection)))) {
      yield* dbCall(() => documents.createCollection({ name: collection, surface: "database", columns }));
    }
  });
  return { documents, transaction, get, put, ensure };
}
export type HostingStore = ReturnType<typeof hostingStore>;

export function platformClient(fetch: NonNullable<ZelavisServiceSetupCoreContext["fetch"]>, base: string) {
  return (method: string, path: string, body?: object) => Effect.tryPromise({
    try: signal => fetch(new Request(`http://localhost${base}${path}`, {
      method,
      signal,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })),
    catch: () => platformFailure(503),
  });
}
export type Platform = ReturnType<typeof platformClient>;
export const platformJson = <A>(response: Response, parse: (body: unknown) => A) => {
  if (!response.ok) return Effect.fail(platformFailure(response.status));
  return Effect.tryPromise({ try: () => response.json(), catch: () => platformFailure(response.status) }).pipe(
    Effect.flatMap(value => Effect.try({ try: () => parse(value), catch: () => platformFailure(response.status) })),
  );
};
export const ok = (body: unknown, status = 200): ZelavisRouteResponse =>
  ({ status, body, headers: { "cache-control": "no-store" } });

export function route(
  resource: string,
  action: string,
  method: ZelavisServerRoute["method"],
  access: ZelavisServerRoute["access"],
  run: (context: ZelavisRouteContext) => Effect.Effect<ZelavisRouteResponse, HostingError>,
  path = `/hosting/${resource}`,
): ZelavisServerRoute {
  return {
    id: `hosting.${resource}.${action}`, method, path, access,
    meta: { pluginResource: resource, pluginAction: action },
    maxRequestBodyBytes: 16 * 1024,
    invalidJsonBodyCode: "invalid_hosting_request",
    handler: context => Effect.runPromise(run(context).pipe(Effect.catch(error => Effect.succeed(
      ok({ error: error.code, message: error.message }, error.status),
    )))),
  };
}
