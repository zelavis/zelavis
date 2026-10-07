import { Data, Effect, Schema } from "effect";

export class ApiError extends Data.TaggedError("ApiError")<{ message: string; status?: number }> {}
const ApiConfig = Schema.Struct({ api: Schema.Struct({ basePath: Schema.String }), rootPath: Schema.String, capabilities: Schema.optional(Schema.Unknown), services: Schema.optional(Schema.Array(Schema.Unknown)) });
const Bootstrap = Schema.Struct({ required: Schema.Boolean, providers: Schema.Array(Schema.String), enrollmentProviders: Schema.Array(Schema.String) });
const Project = Schema.Struct({ id: Schema.String, name: Schema.String, recipe: Schema.optional(Schema.Unknown), kind: Schema.optional(Schema.String), runtimeKind: Schema.optional(Schema.String), runtime: Schema.Struct({ status: Schema.String, error: Schema.optional(Schema.String) }), deletion: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.String) });
export type Project = typeof Project.Type & { status: string };
export type Config = typeof ApiConfig.Type;
export const Projects = Schema.Struct({ projects: Schema.Array(Project) });
export const BootstrapStatus = Bootstrap;

const responseLimit = 8 * 1024 * 1024;
const responseText = Effect.fn("new-ui.responseText")(function*(response: Response) {
  if (Number(response.headers.get("content-length")) > responseLimit) return yield* Effect.fail(new ApiError({ message: "The API response exceeded the dashboard limit." }));
  if (!response.body) return "";
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => response.body!.getReader()),
    reader => Effect.gen(function*() {
      const decoder = new TextDecoder();
      const parts: string[] = [];
      let bytes = 0;
      while (true) {
        const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => new ApiError({ message: "Could not read the API response." }) });
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > responseLimit) return yield* Effect.fail(new ApiError({ message: "The API response exceeded the dashboard limit." }));
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return parts.join("");
    }),
    reader => Effect.tryPromise({ try: () => reader.cancel(), catch: cause => cause }).pipe(Effect.catch(cause => Effect.logWarning("API response stream cleanup failed", cause)))
  );
});

export const request = Effect.fn("new-ui.request")(function*(path: string, method = "GET", body?: unknown) {
  if (!path.startsWith("/zelavis/api/") || path.includes("..")) return yield* Effect.fail(new ApiError({ message: "Refused a request outside the Zelavis API." }));
  const response = yield* Effect.tryPromise({
    try: signal => fetch(path, { signal, method, credentials: "same-origin", headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    catch: cause => new ApiError({ message: cause instanceof Error ? cause.message : "Could not connect to Zelavis." })
  });
  const text = yield* responseText(response);
  const data = text ? yield* Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new ApiError({ message: `Invalid JSON response (${response.status}).`, status: response.status }) }) : null;
  if (!response.ok) {
    const message = object(data).error;
    return yield* Effect.fail(new ApiError({ message: typeof message === "string" ? message : `Request failed (${response.status}).`, status: response.status }));
  }
  return data;
}, Effect.timeout("30 seconds"), Effect.mapError(error => error instanceof ApiError ? error : new ApiError({ message: "Zelavis did not respond within 30 seconds." })));

export function object(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function array(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function label(value: unknown, fallback = "—"): string { return typeof value === "string" || typeof value === "number" ? String(value) : fallback; }
export function decode<S extends Schema.Top>(schema: S, value: unknown) { return Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => new ApiError({ message: "The runtime returned an unexpected response shape." }))); }
export const loadConfig = request("/zelavis/api/v1/runtime/config").pipe(Effect.flatMap(value => decode(ApiConfig, value)));
export function bootstrap(config: Config) { return request(`${config.api.basePath}/auth/bootstrap`).pipe(Effect.flatMap(value => decode(Bootstrap, value))); }
export function projects(config: Config) { return request(`${config.api.basePath}/runtime/projects`).pipe(Effect.flatMap(value => decode(Projects, value)), Effect.map(value => value.projects.map(project => ({ ...project, status: project.runtime.status, error: project.runtime.error })))); }
export const projectConfig = Effect.fn("new-ui.projectConfig")(function*(control: Config, projectId: string) {
  const proxy = `${control.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/proxy`;
  const config = yield* request(`${proxy}/zelavis/api/v1/runtime/config`).pipe(Effect.flatMap(value => decode(ApiConfig, value)));
  if (!config.api.basePath.startsWith("/zelavis/api/")) return yield* Effect.fail(new ApiError({ message: "Invalid project API mount." }));
  return { ...config, api: { basePath: `${proxy}${config.api.basePath}` } };
});
