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

  async function getDirectory(): Promise<AcmeDirectory> {
    if (cachedDirectory) {
      return cachedDirectory;
    }
    const response = await customFetch(directoryUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new AcmeError(
        `Failed to fetch ACME directory from ${directoryUrl}`,
        response.status,
      );
    }
    cachedDirectory = (await response.json()) as AcmeDirectory;
    return cachedDirectory;
  }

  async function fetchNonce(): Promise<string> {
    const dir = await getDirectory();
    const response = await customFetch(dir.newNonce, {
      method: "HEAD",
    });
    const nonce = response.headers.get("replay-nonce");
    if (!nonce) {
      throw new AcmeError("Failed to obtain Replay-Nonce from ACME server", 500);
    }
    return nonce;
  }

  async function getNonce(): Promise<string> {
    if (cachedNonce) {
      const n = cachedNonce;
      cachedNonce = undefined;
      return n;
    }
    return fetchNonce();
  }

  async function postJws(
    url: string,
    payload: Record<string, unknown> | string,
    retryOnBadNonce = true,
  ): Promise<Response> {
    const nonce = await getNonce();
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

    const response = await customFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/jose+json",
      },
      body: JSON.stringify(jws),
    });

    // Update next cached nonce if present
    const nextNonce = response.headers.get("replay-nonce");
    if (nextNonce) {
      cachedNonce = nextNonce;
    }

    if (!response.ok) {
      let errorBody: { type?: string; detail?: string; status?: number } = {};
      try {
        errorBody = (await response.json()) as typeof errorBody;
      } catch {
        // non-json error body
      }

      // Handle badNonce retry per RFC 8555 Section 6.5
      if (
        retryOnBadNonce &&
        errorBody.type === "urn:ietf:params:acme:error:badNonce"
      ) {
        cachedNonce = undefined;
        return postJws(url, payload, false);
      }

      throw new AcmeError(
        `ACME request to ${url} failed with status ${response.status}`,
        response.status,
        errorBody.type ?? "ACME_ERROR",
        errorBody.detail,
      );
    }

    return response;
  }

  return {
    getDirectory,

    getAccountThumbprint(): string {
      return keyThumbprint;
    },

    async createOrGetAccount(accountOptions = {}): Promise<AcmeAccountDetails> {
      const dir = await getDirectory();
      const payload: Record<string, unknown> = {
        termsOfServiceAgreed: accountOptions.termsOfServiceAgreed !== false,
      };
      if (accountOptions.contactEmail) {
        payload.contact = [`mailto:${accountOptions.contactEmail}`];
      }

      const response = await postJws(dir.newAccount, payload);
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
    },

    async createOrder(identifiers: readonly string[]): Promise<AcmeOrder> {
      const dir = await getDirectory();
      const payload = {
        identifiers: identifiers.map((id) => ({
          type: "dns" as const,
          value: id,
        })),
      };

      const response = await postJws(dir.newOrder, payload);
      const orderUrl = response.headers.get("location");
      if (!orderUrl) {
        throw new AcmeError("ACME newOrder response did not include Location header", 500);
      }

      const orderData = (await response.json()) as {
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
    },

    async getAuthorization(authzUrl: string): Promise<AcmeAuthorization> {
      // POST-as-GET with empty payload string per RFC 8555 Section 6.3
      const response = await postJws(authzUrl, "");
      const data = (await response.json()) as {
        status: AcmeAuthorization["status"];
        identifier: AcmeIdentifier;
        challenges: AcmeChallenge[];
      };
      return {
        status: data.status,
        identifier: data.identifier,
        challenges: data.challenges,
      };
    },

    async notifyChallenge(challengeUrl: string): Promise<AcmeChallenge> {
      const response = await postJws(challengeUrl, {});
      return (await response.json()) as AcmeChallenge;
    },

    async pollAuthorization(
      authzUrl: string,
      pollOptions = {},
    ): Promise<AcmeAuthorization> {
      const maxWaitMs = pollOptions.maxWaitMs ?? 30000;
      const pollIntervalMs = pollOptions.pollIntervalMs ?? 500;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        const authz = await this.getAuthorization(authzUrl);
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
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      throw new AcmeError(
        `Timed out waiting for ACME authorization ${authzUrl}`,
        408,
        "ACME_TIMEOUT",
      );
    },

    async finalizeOrder(
      finalizeUrl: string,
      csrDer: Buffer | Uint8Array,
    ): Promise<AcmeOrder> {
      const payload = {
        csr: toBase64Url(csrDer),
      };
      const response = await postJws(finalizeUrl, payload);
      const data = (await response.json()) as {
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
    },

    async pollOrder(
      orderUrl: string,
      pollOptions = {},
    ): Promise<AcmeOrder> {
      const maxWaitMs = pollOptions.maxWaitMs ?? 30000;
      const pollIntervalMs = pollOptions.pollIntervalMs ?? 500;
      const deadline = Date.now() + maxWaitMs;

      while (Date.now() < deadline) {
        const response = await postJws(orderUrl, "");
        const data = (await response.json()) as {
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

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }

      throw new AcmeError(
        `Timed out waiting for ACME order ${orderUrl} to become valid`,
        408,
        "ACME_TIMEOUT",
      );
    },

    async downloadCertificate(certificateUrl: string): Promise<string> {
      const response = await postJws(certificateUrl, "");
      return response.text();
    },
  };
}
