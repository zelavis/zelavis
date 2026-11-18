import type { IncomingHttpHeaders } from "node:http";
import * as Effect from "effect/Effect";
import { integration } from "../core/runtime/effect-boundary.js";
import { createGatewayAuthorityNonce, createGatewayNonceTracker, signGatewayDispatch, splitGatewayDispatch, verifyGatewayAuthority, verifyGatewayClientAddress, ZELAVIS_GATEWAY_CLIENT_ADDRESS_HEADER, ZELAVIS_GATEWAY_AUTHORITY_HEADER, ZELAVIS_GATEWAY_AUTHORITY_TTL_MS } from "../platform/gateway-authority.js";

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
    const proof = headers[ZELAVIS_GATEWAY_CLIENT_ADDRESS_HEADER];
    delete headers[ZELAVIS_GATEWAY_CLIENT_ADDRESS_HEADER];
    const claims = typeof token === "string" ? yield* integration(() => verifyGatewayAuthority(options.parentSecret(), token, {
      audienceProjectId: options.projectId, consumeNonce: nonces,
    })) : undefined;
    const clientAddress = claims !== undefined && typeof token === "string" && typeof proof === "string"
      ? yield* integration(() => verifyGatewayClientAddress(options.parentSecret(), token, proof)) : undefined;
    return () => Effect.gen(function* () {
      if (claims) {
        const signed = yield* integration(() => signGatewayDispatch(options.workerSecret(), {
          ...claims, ...(clientAddress === undefined ? {} : { clientAddress }),
          expiresAt: Date.now() + ZELAVIS_GATEWAY_AUTHORITY_TTL_MS, nonce: createGatewayAuthorityNonce(),
        }));
        const { authority, addressProof } = splitGatewayDispatch(signed);
        headers[ZELAVIS_GATEWAY_AUTHORITY_HEADER] = authority;
        if (addressProof !== undefined) headers[ZELAVIS_GATEWAY_CLIENT_ADDRESS_HEADER] = addressProof;
      }
      return headers;
    });
  });
}
