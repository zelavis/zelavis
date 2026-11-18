import { Effect } from "effect";
import { createServicePageFetch, isSandboxedServicePage } from "zelavis/sdk/service-page";
export { Effect };

/** Relative requests stay inside the frame's service grant, including through a Project proxy. */
export function createPageApi(namespace: string) {
  const fetchPage = createServicePageFetch();
  const apiBase = new URL("../../../../", location.href).pathname.replace(/\/$/, "");
  return (path: string, input?: { method?: string; body?: unknown }) => Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() => fetchPage(isSandboxedServicePage() ? path : `${apiBase}/plugins/${namespace}/${path}`, {
      method: input?.method ?? "GET", headers: { accept: "application/json", ...(input?.body === undefined ? {} : { "content-type": "application/json" }) },
      body: input?.body === undefined ? undefined : JSON.stringify(input.body),
    }));
    const body: unknown = yield* Effect.tryPromise(() => response.json());
    if (!response.ok) return yield* Effect.fail(new Error(`Request failed (${response.status}).`));
    return body;
  });
}
