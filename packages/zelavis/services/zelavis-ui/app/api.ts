import { Data, Effect, Schema } from "effect";
import { API_PREFIX } from "./mount.ts";

export class ApiError extends Data.TaggedError("ApiError")<{ message: string; status?: number }> {}
const ApiConfig = Schema.Struct({ api: Schema.Struct({ basePath: Schema.String }), rootPath: Schema.String, access: Schema.optional(Schema.Unknown), capabilities: Schema.optional(Schema.Unknown), services: Schema.optional(Schema.Array(Schema.Unknown)), serviceRegistry: Schema.optional(Schema.Array(Schema.Unknown)) });
const Bootstrap = Schema.Struct({ required: Schema.Boolean, providers: Schema.Array(Schema.String), enrollmentProviders: Schema.Array(Schema.String) });
const Project = Schema.Struct({ id: Schema.String, name: Schema.String, recipe: Schema.optional(Schema.Unknown), capabilities: Schema.optional(Schema.Unknown), recipeStatus: Schema.optional(Schema.Unknown), engineVersion: Schema.optional(Schema.String), preview: Schema.optional(Schema.Unknown), kind: Schema.optional(Schema.String), runtimeKind: Schema.optional(Schema.String), runtime: Schema.Struct({ status: Schema.String, error: Schema.optional(Schema.String) }), deletion: Schema.optional(Schema.Unknown), error: Schema.optional(Schema.String) });
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
  if (!path.startsWith(API_PREFIX) || path.includes("..")) return yield* Effect.fail(new ApiError({ message: "Refused a request outside the Zelavis API." }));
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
export const loadConfig = request(`${API_PREFIX}v1/runtime/config`).pipe(Effect.flatMap(value => decode(ApiConfig, value)));
export function bootstrap(config: Config) { return request(`${config.api.basePath}/auth/bootstrap`).pipe(Effect.flatMap(value => decode(Bootstrap, value))); }
export function projects(config: Config) { return request(`${config.api.basePath}/runtime/projects`).pipe(Effect.flatMap(value => decode(Projects, value)), Effect.map(value => value.projects.map(project => ({ ...project, status: project.runtime.status, error: project.runtime.error })))); }
export const projectConfig = Effect.fn("new-ui.projectConfig")(function*(control: Config, projectId: string) {
  const proxy = `${control.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/proxy`;
  const config = yield* request(`${proxy}${API_PREFIX}v1/runtime/config`).pipe(Effect.flatMap(value => decode(ApiConfig, value)));
  if (!config.api.basePath.startsWith(API_PREFIX)) return yield* Effect.fail(new ApiError({ message: "Invalid project API mount." }));
  return { ...config, api: { basePath: `${proxy}${config.api.basePath}` } };
});

export function storagePath(path: string) {
  const parts = path.split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === "..") || path.length > 4096) throw new Error("Use a file path without empty or parent segments.");
  return parts.map(encodeURIComponent).join("/");
}
/** XHR is the browser transport adapter; Effect owns progress, timeout and interruption. */
export const uploadFile = Effect.fn("new-ui.uploadFile")(function*(apiBase: string, path: string, file: File, progress: (percent: number) => void, headers: Readonly<Record<string, string>> = {}) {
  if (!apiBase.startsWith(API_PREFIX) || apiBase.includes("..")) return yield* Effect.fail(new ApiError({ message: "Invalid storage API mount." }));
  if (file.size > 32 * 1024 * 1024) return yield* Effect.fail(new ApiError({ message: "Dashboard uploads are limited to 32 MB." }));
  const encoded = yield* Effect.try({ try: () => storagePath(path), catch: cause => new ApiError({ message: String(cause) }) });
  return yield* Effect.callback<unknown, ApiError>(resume => {
    const transport = new XMLHttpRequest();
    transport.open("PUT", `${apiBase}/storage/files/${encoded}`);
    transport.withCredentials = true;
    transport.setRequestHeader("content-type", file.type || "application/octet-stream");
    for (const [name, value] of Object.entries(headers)) transport.setRequestHeader(name, value);
    transport.upload.onprogress = event => { if (event.lengthComputable && event.total > 0) progress(Math.round(event.loaded * 100 / event.total)); };
    transport.onload = () => {
      if (transport.responseText.length > responseLimit) { resume(Effect.fail(new ApiError({ message: "Upload response exceeded the dashboard limit." }))); return; }
      let result: unknown;
      try { result = JSON.parse(transport.responseText); }
      catch (cause) { resume(Effect.fail(new ApiError({ message: `Invalid upload response: ${String(cause)}` }))); return; }
      resume(transport.status >= 200 && transport.status < 300 ? Effect.succeed(result) : Effect.fail(new ApiError({ message: label(object(result).error, "Upload failed."), status: transport.status })));
    };
    transport.onerror = () => resume(Effect.fail(new ApiError({ message: "Upload connection failed." })));
    transport.onabort = () => resume(Effect.fail(new ApiError({ message: "Upload cancelled." })));
    transport.send(file);
    return Effect.sync(() => { transport.onload = null; transport.onerror = null; transport.onabort = null; transport.upload.onprogress = null; if (transport.readyState !== 4) transport.abort(); });
  }).pipe(Effect.timeout("60 seconds"), Effect.mapError(error => error instanceof ApiError ? error : new ApiError({ message: "Upload timed out after 60 seconds." })));
});
