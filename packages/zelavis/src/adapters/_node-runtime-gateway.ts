import type { IncomingHttpHeaders } from "node:http";
import { Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import { createGatewayAuthorityNonce, createGatewayNonceTracker, signGatewayAuthority, verifyGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_HEADER, ZELAVIS_GATEWAY_AUTHORITY_TTL_MS } from "../platform/gateway-authority.js";

/** The stable Project supervisor consumes external nonces before admission.
 * Workers receive freshly signed, private, single-use envelopes after admission,
 * so queuing cannot expire a valid caller or reset replay protection on update.
 * The parent key and worker key are deliberately distinct and never persisted.
 */
export function createNodeRuntimeGateway(options: {
  readonly projectId: string;
  readonly parentSecret: () => string;
  readonly workerSecret: () => string;
}) {
  const nonces = createGatewayNonceTracker();
  return Effect.fn("RuntimeGateway.authenticate")(function* (input: IncomingHttpHeaders) {
    const headers = { ...input };
    const token = headers[ZELAVIS_GATEWAY_AUTHORITY_HEADER];
    delete headers[ZELAVIS_GATEWAY_AUTHORITY_HEADER];
    const claims = typeof token === "string" ? yield* integration(() => verifyGatewayAuthority(options.parentSecret(), token, {
      audienceProjectId: options.projectId, consumeNonce: nonces,
    })) : undefined;
    return () => Effect.gen(function* () {
      if (claims) headers[ZELAVIS_GATEWAY_AUTHORITY_HEADER] = yield* integration(() => signGatewayAuthority(options.workerSecret(), {
        ...claims, expiresAt: Date.now() + ZELAVIS_GATEWAY_AUTHORITY_TTL_MS, nonce: createGatewayAuthorityNonce(),
      }));
      return headers;
    });
  });
}
