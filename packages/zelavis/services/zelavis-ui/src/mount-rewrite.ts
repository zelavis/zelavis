/**
 * Mounting one dashboard build at any root path.
 *
 * The build is compiled against the placeholder root `/__zelavis__` (see `app/mount.ts`). The Platform serves it at
 * its configured `rootPath`, so everything that leaves this package has the placeholder replaced by that mount,
 * and every request that enters it has the mount turned back into the placeholder before Fuzor's server handler sees
 * it. The mount is the root path without a trailing slash: `/zelavis`, `/admin`, or `""` at the origin root, which
 * turns `/__zelavis__/assets/x.js` into `/assets/x.js`.
 */
export const PLACEHOLDER = "/__zelavis__";

/** `/zelavis/` and `/zelavis` are `/zelavis`; `/` is the empty mount. Anything else is refused. */
export function mountOf(rootPath: string): string {
  if (typeof rootPath !== "string" || !rootPath.startsWith("/") || /[?#\s]|\/\.\.?(\/|$)|\/\//.test(rootPath)) {
    throw new Error(`The dashboard cannot be mounted at "${String(rootPath)}".`);
  }
  if (rootPath.includes(PLACEHOLDER)) throw new Error("The dashboard cannot be mounted at its own build placeholder.");
  return rootPath.replace(/\/+$/, "");
}

export function replacePlaceholder(text: string, mount: string): string {
  return text.includes(PLACEHOLDER) ? text.replaceAll(PLACEHOLDER, mount) : text;
}

/** The request as the build sees it: the mount's path prefix is the placeholder. Undefined when it is outside the mount. */
export function requestIntoBuild(request: Request, mount: string): Request | undefined {
  const url = new URL(request.url);
  if (mount === "") url.pathname = `${PLACEHOLDER}${url.pathname}`;
  else if (url.pathname === mount || url.pathname.startsWith(`${mount}/`)) url.pathname = `${PLACEHOLDER}${url.pathname.slice(mount.length)}`;
  else return undefined;
  // Fuzor's server-view endpoint takes the page it should render as a path in its query, written with the real mount.
  if (url.pathname === `${PLACEHOLDER}/_fuzor/render`) {
    const target = url.searchParams.get("url");
    if (target !== null) {
      if (mount === "") url.searchParams.set("url", `${PLACEHOLDER}${target}`);
      else if (target === mount || target.startsWith(`${mount}/`) || target.startsWith(`${mount}?`)) url.searchParams.set("url", `${PLACEHOLDER}${target.slice(mount.length)}`);
    }
  }
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
  return new Request(url, { method: request.method, headers: request.headers, signal: request.signal, ...(body ? { body, duplex: "half" } as RequestInit : {}) });
}

const TEXTUAL = /^(?:text\/|application\/(?:json|javascript|x-ndjson|manifest\+json|xml)|image\/svg\+xml)/i;
export const isTextual = (contentType: string | null | undefined): boolean => TEXTUAL.test(contentType ?? "");

/** The length of the longest ending of `text` that begins the placeholder, which a later chunk may complete. */
function pendingEnding(text: string): number {
  for (let length = Math.min(PLACEHOLDER.length - 1, text.length); length > 0; length -= 1) {
    if (PLACEHOLDER.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}

/** Replaces the placeholder in a stream of text without splitting a match across chunks. */
export function placeholderTransform(mount: string): TransformStream<string, string> {
  let carry = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const text = carry + chunk;
      const held = pendingEnding(text);
      carry = text.slice(text.length - held);
      const ready = text.slice(0, text.length - held);
      if (ready) controller.enqueue(replacePlaceholder(ready, mount));
    },
    flush(controller) {
      if (carry) controller.enqueue(replacePlaceholder(carry, mount));
    },
  });
}

/** A response from the build, ready for the Platform: textual bodies and the redirect target carry the real mount. */
export function responseOutOfBuild(response: Response, mount: string): Response {
  const headers = new Headers(response.headers);
  const location = headers.get("location");
  if (location) headers.set("location", replacePlaceholder(location, mount));
  if (!response.body || !isTextual(headers.get("content-type"))) return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  // The length changes with the replacement, and the body is no longer byte-for-byte what was compressed.
  headers.delete("content-length");
  headers.delete("content-encoding");
  headers.delete("etag");
  const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(placeholderTransform(mount)).pipeThrough(new TextEncoderStream());
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
