import { X509Certificate } from "node:crypto";
import type { ClientRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { Data, Effect } from "effect";
import { present } from "../core/runtime/effect-boundary.js";

/**
 * A `fetch` over `node:https` that decides for itself whom to trust, for a
 * machine that must authenticate the Platform before it sends a credential.
 *
 * Exactly one trust mode applies, and plain `http:` is never one of them:
 * - a **fingerprint** pin: the peer's leaf certificate must have this SHA-256,
 *   checked on the connection itself before any request byte is written, and no
 *   chain or name check applies (a pin replaces CA trust, so a self-signed
 *   Platform is fine and a CA-signed lookalike is not);
 * - a **CA bundle** (PEM): ordinary chain and hostname verification against
 *   only those roots;
 * - **neither**: ordinary verification against Node's bundled public roots.
 *
 * Bounds: one request at a time per call, a request timeout, and a response
 * limit, so a hostile peer cannot hold or flood the caller. Redirects are not
 * followed: the response is returned as is, so a redirect can never carry the
 * credential to another origin.
 */

/** Every way this fetch can fail, with the original error kept as the cause. */
export class PinnedFetchError extends Data.TaggedError("PinnedFetchError")<{ readonly message: string; readonly cause?: unknown }> {}

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface PinnedFetchOptions {
  /** `sha256:` followed by 64 hex digits, colons and case ignored. */
  readonly fingerprint?: string;
  /** PEM roots to trust instead of Node's bundled ones. */
  readonly caPem?: string;
}

const FINGERPRINT = /^(?:sha256:)?([0-9a-f]{2}(?::?[0-9a-f]{2}){31})$/i;

/** Canonical lowercase hex, or undefined when the text is not a SHA-256 fingerprint. */
export function normalizeFingerprint(text: string): string | undefined {
  const match = FINGERPRINT.exec(text.trim());
  return match?.[1]?.replaceAll(":", "").toLowerCase();
}

/** Constant-time comparison of two equal-purpose hex digests. */
function sameDigest(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export function createPinnedFetch(options: PinnedFetchOptions): typeof fetch {
  if (options.fingerprint !== undefined && options.caPem !== undefined) {
    throw new TypeError("Choose a certificate fingerprint or a CA bundle, not both.");
  }
  const pin = options.fingerprint === undefined ? undefined : normalizeFingerprint(options.fingerprint);
  if (options.fingerprint !== undefined && pin === undefined) {
    throw new TypeError("The fingerprint must be a SHA-256 of 64 hex digits, optionally prefixed with sha256:.");
  }

  /**
   * The request, on a socket that is already verified when a pin applies. Nothing
   * is written until the peer's certificate has matched: with `rejectUnauthorized`
   * off Node ignores a `checkServerIdentity` failure, so the check cannot live
   * there.
   */
  const exchange = (input: URL, method: string, headers: Record<string, string>, body: Uint8Array, signal: AbortSignal | undefined) =>
    Effect.callback<Response, PinnedFetchError>((resume) => {
      if (signal?.aborted) {
        resume(Effect.fail(new PinnedFetchError({ message: "The request was aborted." })));
        return Effect.void;
      }
      const hostname = input.hostname.replace(/^\[|\]$/g, "");
      const port = Number(input.port || 443);
      let socket: TLSSocket | undefined;
      let call: ClientRequest | undefined;
      const fail = (error: Error) => resume(Effect.fail(new PinnedFetchError({ message: error.message, cause: error })));
      const abort = () => { socket?.destroy(); call?.destroy(new Error("The request was aborted.")); };

      const send = (connection?: TLSSocket) => {
        call = httpsRequest({
          hostname, port, path: `${input.pathname}${input.search}`, method,
          headers: { ...headers, "content-length": String(body.length) },
          timeout: REQUEST_TIMEOUT_MS,
          ...(connection === undefined
            ? { rejectUnauthorized: true, ...(options.caPem === undefined ? {} : { ca: options.caPem }) }
            // No `agent`: with `agent: false` Node ignores createConnection and opens its own connection.
            : { createConnection: () => connection }),
        }, (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              call?.destroy(new Error("The Platform's response exceeded the limit."));
              return;
            }
            chunks.push(chunk);
          });
          response.once("end", () => {
            const status = response.statusCode ?? 0;
            const replyHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              if (value !== undefined) replyHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
            }
            const empty = status === 204 || status === 205 || status === 304;
            resume(Effect.succeed(new Response(empty ? null : Buffer.concat(chunks), { status, headers: replyHeaders })));
          });
          response.once("error", fail);
        });
        call.once("timeout", () => call?.destroy(new Error("The Platform did not answer in time.")));
        call.once("error", fail);
        call.end(body);
      };

      if (pin === undefined) {
        send();
      } else {
        socket = tlsConnect({
          host: hostname, port, rejectUnauthorized: false, timeout: REQUEST_TIMEOUT_MS,
          ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        });
        socket.once("timeout", () => socket?.destroy(new Error("The Platform did not answer in time.")));
        socket.once("error", fail);
        socket.once("secureConnect", () => {
          const raw = socket?.getPeerCertificate(true)?.raw;
          const presented = raw ? new X509Certificate(raw).fingerprint256.replaceAll(":", "").toLowerCase() : "";
          if (!sameDigest(presented, pin)) {
            socket?.destroy();
            fail(new Error("The Platform's certificate does not match the pinned fingerprint."));
            return;
          }
          send(socket);
        });
      }
      signal?.addEventListener("abort", abort, { once: true });
      return Effect.sync(() => {
        signal?.removeEventListener("abort", abort);
        socket?.destroy();
        call?.destroy();
      });
    });

  return ((resource: RequestInfo | URL, init?: RequestInit) => present(Effect.gen(function* () {
    const request = new Request(resource, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:") return yield* Effect.fail(new PinnedFetchError({ message: "The Platform must be reached over https." }));
    if (url.username || url.password) return yield* Effect.fail(new PinnedFetchError({ message: "Credentials in the Platform URL are not allowed." }));
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MAX_REQUEST_BYTES) return yield* Effect.fail(new PinnedFetchError({ message: "The request is too large." }));
    const body = new Uint8Array(yield* Effect.promise(() => request.arrayBuffer()));
    if (body.length > MAX_REQUEST_BYTES) return yield* Effect.fail(new PinnedFetchError({ message: "The request is too large." }));
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => { headers[name] = value; });
    return yield* exchange(url, request.method, headers, body, request.signal);
  }))) as typeof fetch;
}
