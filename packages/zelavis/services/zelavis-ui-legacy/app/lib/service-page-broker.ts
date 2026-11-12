/**
 * Brokered API access for sandboxed service pages.
 *
 * A service page renders in a frame. A page from a service the operator
 * composed themselves runs same-origin, because they already chose to run its
 * code. A page from a service installed at runtime does not: its frame is
 * sandboxed without `allow-same-origin`, so its document has an opaque origin
 * and can neither reach the dashboard nor send the session cookie anywhere.
 *
 * That leaves it with no way to call the Platform at all, which is the point —
 * access is granted back one request at a time, through this broker, and only
 * within the API namespace the service itself owns.
 *
 * This is a real boundary rather than defence in depth. A sandboxed page holds
 * no credentials, so the broker is the only thing that can make a call on its
 * behalf. It is still not the *last* boundary: the Platform enforces
 * permissions on every route regardless, and must never rely on this.
 */

/** A request a sandboxed page is asking the dashboard to make for it. */
export interface ServicePageBrokerRequest {
  readonly zelavis: "service-page-request";
  readonly id: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}

export interface ServicePageBrokerGrant {
  /** Service that owns the framed page. */
  readonly serviceName: string;
  /** Absolute API path prefix this page may reach, e.g. `/zelavis/api/v1/commerce`. */
  readonly apiPath: string;
}

export function isServicePageBrokerRequest(
  value: unknown,
): value is ServicePageBrokerRequest {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  return (
    message.zelavis === "service-page-request" &&
    typeof message.id === "string" &&
    typeof message.path === "string"
  );
}

const ALLOWED_METHODS = new Set(["GET", "POST", "PATCH", "PUT", "DELETE"]);

/**
 * Resolves the absolute path a brokered request may be sent to, or undefined
 * when the grant does not cover it.
 *
 * **Paths are relative to the service's own namespace**, and a leading slash
 * means the root of that namespace rather than the root of the site. A page
 * asking for `/runtime/services` therefore gets `<grant>/runtime/services`,
 * which does not exist, rather than the Platform's service registry.
 *
 * The path is resolved against the grant before it is compared, so `../`
 * cannot walk out of the namespace, and a resolved path counts as inside the
 * grant only when the next character is a boundary — otherwise a grant on
 * `/api/v1/shop` would also cover `/api/v1/shopadmin`.
 */
export function resolveBrokeredPath(
  requested: string,
  grant: ServicePageBrokerGrant,
): string | undefined {
  if (typeof requested !== "string" || !requested) return undefined;

  // A scheme-relative or absolute URL would leave the Platform entirely,
  // taking whatever the dashboard's session can reach with it.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(requested) || requested.startsWith("//")) {
    return undefined;
  }

  const base = new URL(
    grant.apiPath.endsWith("/") ? grant.apiPath : `${grant.apiPath}/`,
    "http://service-page.invalid",
  );

  let resolved: URL;
  try {
    resolved = new URL(requested.replace(/^\/+/, ""), base);
  } catch {
    return undefined;
  }

  const prefix = grant.apiPath.replace(/\/+$/, "");
  const path = resolved.pathname;

  if (path !== prefix && !path.startsWith(`${prefix}/`)) {
    return undefined;
  }

  return `${path}${resolved.search}`;
}

export interface ServicePageBrokerOptions {
  readonly grant: ServicePageBrokerGrant;
  readonly frame: HTMLIFrameElement;
  readonly fetchImplementation?: typeof globalThis.fetch;
}

/**
 * Installs the broker for one framed page. Returns a teardown function.
 */
export function installServicePageBroker(
  options: ServicePageBrokerOptions,
): () => void {
  const doFetch = options.fetchImplementation ?? globalThis.fetch;

  const onMessage = async (event: MessageEvent) => {
    // Identity comes from the window the message came from, not from anything
    // inside it. A sandboxed frame has an opaque origin, so `event.origin` is
    // the string "null" for every such frame and cannot distinguish them.
    if (event.source !== options.frame.contentWindow) return;
    if (!isServicePageBrokerRequest(event.data)) return;

    const request = event.data;
    const reply = (payload: Record<string, unknown>) => {
      // Targeted at "*" because the recipient has an opaque origin, which no
      // targetOrigin can name. Safe here: the frame is the only recipient, and
      // the payload is a response to something it asked for.
      options.frame.contentWindow?.postMessage(
        { zelavis: "service-page-response", id: request.id, ...payload },
        "*",
      );
    };

    const method = (request.method ?? "GET").toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      reply({ error: `Method ${method} is not available to a service page.` });
      return;
    }

    const path = resolveBrokeredPath(request.path, options.grant);
    if (!path) {
      reply({
        error: `${options.grant.serviceName} may only call its own API under ${options.grant.apiPath}.`,
      });
      return;
    }

    try {
      const response = await doFetch(path, {
        method,
        headers:
          request.body === undefined
            ? { accept: "application/json" }
            : { accept: "application/json", "content-type": "application/json" },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
      });

      reply({
        status: response.status,
        ok: response.ok,
        body: await response.json().catch(() => undefined),
      });
    } catch (error) {
      reply({ error: error instanceof Error ? error.message : "Request failed." });
    }
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
