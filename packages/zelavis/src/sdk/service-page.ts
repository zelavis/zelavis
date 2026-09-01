/**
 * Talking to the Platform from a service page.
 *
 * A page runs in a frame. When its service was composed by the operator the
 * frame is same-origin and ordinary `fetch` works. When the service was
 * installed at runtime the frame is sandboxed to an opaque origin: it holds no
 * session, and its only way out is asking the dashboard to make a call on its
 * behalf, confined to the service's own API.
 *
 * Both are the same thing to a page author. `createServicePageFetch()` returns
 * a `fetch`-shaped function that picks the right one, and the SDK client takes
 * a `fetch`, so the same page code works either way:
 *
 * ```js
 * import { createZelavisClient } from "zelavis/sdk";
 * import { createServicePageFetch } from "zelavis/sdk/service-page";
 *
 * const client = createZelavisClient({
 *   baseUrl: location.origin,
 *   fetch: createServicePageFetch(),
 * });
 * ```
 *
 * The authority is chosen by the Platform, not by the page: a sandboxed page
 * cannot opt into the direct path, because it has no origin to make it from.
 */

const REQUEST_KIND = "service-page-request";
const RESPONSE_KIND = "service-page-response";
const DEFAULT_TIMEOUT_MS = 30_000;

interface BrokerResponse {
  zelavis?: unknown;
  id?: unknown;
  status?: unknown;
  ok?: unknown;
  body?: unknown;
  error?: unknown;
}

/**
 * Whether this page is sandboxed and must go through the broker.
 *
 * A sandboxed document has an opaque origin, which serializes as the string
 * "null". Reading `window.parent.location` would also answer this, but by
 * throwing a cross-origin error — a check that works by catching an exception
 * is one that breaks quietly the day the exception changes.
 */
export function isSandboxedServicePage(): boolean {
  return typeof window !== "undefined" && window.origin === "null";
}

export interface ServicePageFetchOptions {
  /** How long to wait for the dashboard to answer. */
  readonly timeoutMs?: number;
}

/**
 * Returns a `fetch`-shaped function appropriate to how this page is running.
 */
export function createServicePageFetch(
  options: ServicePageFetchOptions = {},
): typeof globalThis.fetch {
  if (!isSandboxedServicePage()) {
    return globalThis.fetch.bind(globalThis);
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 0;

  return async function brokeredFetch(input, init) {
    const path =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    const id = `${Date.now()}-${(nextId += 1)}`;
    const body =
      init?.body === undefined || init.body === null
        ? undefined
        : typeof init.body === "string"
          ? safeParse(init.body)
          : init.body;

    const result = await new Promise<BrokerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        reject(new Error("The dashboard did not answer this request in time."));
      }, timeoutMs);

      const onMessage = (event: MessageEvent) => {
        const data = event.data as BrokerResponse | undefined;
        // Only the parent brokers, and only for the request that is waiting.
        if (event.source !== window.parent) return;
        if (data?.zelavis !== RESPONSE_KIND || data.id !== id) return;

        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(data);
      };

      window.addEventListener("message", onMessage);
      window.parent.postMessage(
        {
          zelavis: REQUEST_KIND,
          id,
          path,
          method: init?.method ?? "GET",
          body,
        },
        // The parent's origin is not readable from a sandboxed document, so it
        // cannot be named here. The dashboard identifies this frame by the
        // window the message came from rather than by anything inside it.
        "*",
      );
    });

    if (typeof result.error === "string") {
      throw new Error(result.error);
    }

    return new Response(
      result.body === undefined ? null : JSON.stringify(result.body),
      {
        status: typeof result.status === "number" ? result.status : 200,
        headers: { "content-type": "application/json" },
      },
    );
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
