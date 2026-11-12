import { integrationValue, unwrapIntegrationResult, presentProtocol, present, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import {
  calculateP256JwkThumbprint,
  exportP256Jwk,
  signJws,
  toBase64Url,
  type P256KeyPair,
} from "./acme-crypto.js";

export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert?: string;
  keyChange?: string;
}

export interface AcmeIdentifier {
  type: "dns";
  value: string;
}

export interface AcmeChallenge {
  type: "http-01" | "dns-01" | string;
  url: string;
  token: string;
  status: "pending" | "processing" | "valid" | "invalid";
  error?: unknown;
}

export interface AcmeAuthorization {
  status: "pending" | "valid" | "invalid" | "deactivated" | "expired" | "revoked";
  identifier: AcmeIdentifier;
  challenges: readonly AcmeChallenge[];
}

export interface AcmeOrder {
  orderUrl: string;
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  identifiers: readonly AcmeIdentifier[];
  authorizations: readonly string[];
  finalize: string;
  certificate?: string;
}

export interface AcmeAccountDetails {
  accountUrl: string;
  keyThumbprint: string;
  jwk: {
    kty: "EC";
    crv: "P-256";
    x: string;
    y: string;
  };
}

export interface CreateAcmeClientOptions {
  directoryUrl: string;
  accountKey: P256KeyPair;
  accountUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class AcmeError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status = 400, code = "ACME_ERROR", detail?: string) {
    super(detail ? `${message}: ${detail}` : message);
    this.name = "AcmeError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface AcmeClient {
  getDirectory(): Promise<AcmeDirectory>;
  getAccountThumbprint(): string;
  createOrGetAccount(options?: {
    contactEmail?: string;
    termsOfServiceAgreed?: boolean;
  }): Promise<AcmeAccountDetails>;
  createOrder(identifiers: readonly string[]): Promise<AcmeOrder>;
  getAuthorization(authzUrl: string): Promise<AcmeAuthorization>;
  notifyChallenge(challengeUrl: string): Promise<AcmeChallenge>;
  pollAuthorization(
    authzUrl: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<AcmeAuthorization>;
  finalizeOrder(
    finalizeUrl: string,
    csrDer: Buffer | Uint8Array,
  ): Promise<AcmeOrder>;
  pollOrder(
    orderUrl: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<AcmeOrder>;
  downloadCertificate(certificateUrl: string): Promise<string>;
}

export function createAcmeClient(options: CreateAcmeClientOptions): AcmeClient {
  const { directoryUrl, accountKey } = options;
  const customFetch = options.fetch ?? globalThis.fetch;

  let cachedDirectory: AcmeDirectory | undefined;
  let cachedNonce: string | undefined;
  let currentAccountUrl = options.accountUrl;

  const publicJwk = exportP256Jwk(accountKey.publicKey);
  const keyThumbprint = calculateP256JwkThumbprint(publicJwk);

  function getDirectory(): Promise<AcmeDirectory> {
    return present(Effect.gen(function* (): Effect.fn.Return<AcmeDirectory, IntegrationFailure> {
    if (cachedDirectory) {
      return cachedDirectory;
    }
    const response = (yield* integrationValue(customFetch(directoryUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    })));
    if (!response.ok) {
      throw new AcmeError(
        `Failed to fetch ACME directory from ${directoryUrl}`,
        response.status,
      );
    }
    cachedDirectory = ((yield* integrationValue(response.json()))) as AcmeDirectory;
    return cachedDirectory;
  }));
  }

  function fetchNonce(): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
    const dir = (yield* integrationValue(getDirectory()));
    const response = (yield* integrationValue(customFetch(dir.newNonce, {
      method: "HEAD",
    })));
    const nonce = response.headers.get("replay-nonce");
    if (!nonce) {
      throw new AcmeError("Failed to obtain Replay-Nonce from ACME server", 500);
    }
    return nonce;
  }));
  }

  function getNonce(): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
    if (cachedNonce) {
      const n = cachedNonce;
      cachedNonce = undefined;
      return n;
    }
    return (yield* integrationValue(fetchNonce()));
  }));
  }

  function postJws(
    url: string,
    payload: Record<string, unknown> | string,
    retryOnBadNonce = true,
  ): Promise<Response> { return presentProtocol(Effect.gen(function* () {
    const nonce = (yield* integrationValue(getNonce()));
    const header = {
      alg: "ES256" as const,
      nonce,
      url,
      ...(currentAccountUrl
        ? { kid: currentAccountUrl }
        : { jwk: publicJwk }),
    };

    const jws = signJws({
      privateKey: accountKey.privateKey,
      header,
      payload,
    });

    const response = (yield* integrationValue(customFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/jose+json",
      },
      body: JSON.stringify(jws),
    })));

    // Update next cached nonce if present
    const nextNonce = response.headers.get("replay-nonce");
    if (nextNonce) {
      cachedNonce = nextNonce;
    }

    if (!response.ok) {
      let errorBody: { type?: string; detail?: string; status?: number } = {};
      try {
        errorBody = (unwrapIntegrationResult(yield* Effect.result(integrationValue(response.json())))) as typeof errorBody;
      } catch {
        // Preserve the status fallback for non-JSON ACME responses.
        errorBody = { status: response.status };
      }

      // Handle badNonce retry per RFC 8555 Section 6.5
      if (
        retryOnBadNonce &&
        errorBody.type === "urn:ietf:params:acme:error:badNonce"
      ) {
        cachedNonce = undefined;
        return (yield* integrationValue(postJws(url, payload, false)));
      }

      throw new AcmeError(
        `ACME request to ${url} failed with status ${response.status}`,
        response.status,
        errorBody.type ?? "ACME_ERROR",
        errorBody.detail,
      );
    }

    return (yield* integrationValue(response));
  }).pipe(Effect.withSpan("createAcmeClient/postJws"))); }

  return {
    getDirectory,

    getAccountThumbprint(): string {
      return keyThumbprint;
    },

    createOrGetAccount(accountOptions = {}): Promise<AcmeAccountDetails> {
    return present(Effect.gen(function* (): Effect.fn.Return<AcmeAccountDetails, IntegrationFailure> {
      const dir = (yield* integrationValue(getDirectory()));
      const payload: Record<string, unknown> = {
        termsOfServiceAgreed: accountOptions.termsOfServiceAgreed !== false,
      };
      if (accountOptions.contactEmail) {
        payload.contact = [`mailto:${accountOptions.contactEmail}`];
      }

      const response = (yield* integrationValue(postJws(dir.newAccount, payload)));
      const location = response.headers.get("location");
      if (!location) {
        throw new AcmeError("ACME newAccount response did not include Location header", 500);
      }

      currentAccountUrl = location;
      return {
        accountUrl: location,
        keyThumbprint,
        jwk: publicJwk,
      };
    }));
  },

    createOrder(identifiers: readonly string[]): Promise<AcmeOrder> {
    return present(Effect.gen(function* (): Effect.fn.Return<AcmeOrder, IntegrationFailure> {
      const dir = (yield* integrationValue(getDirectory()));
      const payload = {
        identifiers: identifiers.map((id) => ({
          type: "dns" as const,
          value: id,
        })),
      };

      const response = (yield* integrationValue(postJws(dir.newOrder, payload)));
      const orderUrl = response.headers.get("location");
      if (!orderUrl) {
        throw new AcmeError("ACME newOrder response did not include Location header", 500);
      }

      const orderData = ((yield* integrationValue(response.json()))) as {
        status: AcmeOrder["status"];
        identifiers: AcmeIdentifier[];
        authorizations: string[];
        finalize: string;
        certificate?: string;
      };

      return {
        orderUrl,
        status: orderData.status,
        identifiers: orderData.identifiers,
        authorizations: orderData.authorizations,
        finalize: orderData.finalize,
        certificate: orderData.certificate,
      };
    }));
  },

    getAuthorization(authzUrl: string): Promise<AcmeAuthorization> {
    return present(Effect.gen(function* (): Effect.fn.Return<AcmeAuthorization, IntegrationFailure> {
      // POST-as-GET with empty payload string per RFC 8555 Section 6.3
      const response = (yield* integrationValue(postJws(authzUrl, "")));
      const data = ((yield* integrationValue(response.json()))) as {
        status: AcmeAuthorization["status"];
        identifier: AcmeIdentifier;
        challenges: AcmeChallenge[];
      };
      return {
        status: data.status,
        identifier: data.identifier,
        challenges: data.challenges,
      };
    }));
  },

    notifyChallenge(challengeUrl: string): Promise<AcmeChallenge> {
    return present(Effect.gen(function* (): Effect.fn.Return<AcmeChallenge, IntegrationFailure> {
      const response = (yield* integrationValue(postJws(challengeUrl, {})));
      return ((yield* integrationValue(response.json()))) as AcmeChallenge;
    }));
  },

    pollAuthorization(
      authzUrl: string,
      pollOptions = {},
    ): Promise<AcmeAuthorization> {
      const self = this;
      return present(Effect.gen(function* (): Effect.fn.Return<AcmeAuthorization, IntegrationFailure> {
      const maxWaitMs = pollOptions.maxWaitMs ?? 30000;
      const pollIntervalMs = pollOptions.pollIntervalMs ?? 500;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        const authz = yield* integrationValue(self.getAuthorization(authzUrl));
        if (authz.status === "valid") {
          return authz;
        }
        if (authz.status === "invalid") {
          const failedChal = authz.challenges.find((c) => c.status === "invalid");
          throw new AcmeError(
            `ACME authorization failed for ${authz.identifier.value}`,
            400,
            "ACME_AUTH_FAILED",
            failedChal?.error ? JSON.stringify(failedChal.error) : undefined,
          );
        }
        yield* Effect.sleep(pollIntervalMs);
      }

      throw new AcmeError(
        `Timed out waiting for ACME authorization ${authzUrl}`,
        408,
        "ACME_TIMEOUT",
      );
      }));
    },

    finalizeOrder(
      finalizeUrl: string,
      csrDer: Buffer | Uint8Array,
    ): Promise<AcmeOrder> {
    return present(Effect.gen(function* (): Effect.fn.Return<AcmeOrder, IntegrationFailure> {
      const payload = {
        csr: toBase64Url(csrDer),
      };
      const response = (yield* integrationValue(postJws(finalizeUrl, payload)));
      const data = ((yield* integrationValue(response.json()))) as {
        status: AcmeOrder["status"];
        identifiers: AcmeIdentifier[];
        authorizations: string[];
        finalize: string;
        certificate?: string;
      };
      return {
        orderUrl: response.headers.get("location") ?? finalizeUrl,
        status: data.status,
        identifiers: data.identifiers,
        authorizations: data.authorizations,
        finalize: data.finalize,
        certificate: data.certificate,
      };
    }));
  },

    pollOrder(
      orderUrl: string,
      pollOptions = {},
    ): Promise<AcmeOrder> {
      return present(Effect.gen(function* (): Effect.fn.Return<AcmeOrder, IntegrationFailure> {
      const maxWaitMs = pollOptions.maxWaitMs ?? 30000;
      const pollIntervalMs = pollOptions.pollIntervalMs ?? 500;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        const response = yield* integrationValue(postJws(orderUrl, ""));
        const data = (yield* integrationValue(response.json())) as {
          status: AcmeOrder["status"];
          identifiers: AcmeIdentifier[];
          authorizations: string[];
          finalize: string;
          certificate?: string;
        };

        if (data.status === "valid" && data.certificate) {
          return {
            orderUrl,
            status: data.status,
            identifiers: data.identifiers,
            authorizations: data.authorizations,
            finalize: data.finalize,
            certificate: data.certificate,
          };
        }

        if (data.status === "invalid") {
          throw new AcmeError(
            `ACME order ${orderUrl} status became invalid`,
            400,
            "ACME_ORDER_INVALID",
          );
        }

        yield* Effect.sleep(pollIntervalMs);
      }

      throw new AcmeError(
        `Timed out waiting for ACME order ${orderUrl} to become valid`,
        408,
        "ACME_TIMEOUT",
      );
      }));
    },

    downloadCertificate(certificateUrl: string): Promise<string> {
    return present(Effect.gen(function* (): Effect.fn.Return<string, IntegrationFailure> {
      const response = (yield* integrationValue(postJws(certificateUrl, "")));
      return (yield* integrationValue(response.text()));
    }));
  },
  };
}
