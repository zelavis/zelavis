import { X509Certificate } from "node:crypto";
import type { ZelavisRuntimeService, ZelavisServerRoute } from "../core/index.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "../system-store.js";
import {
  decryptSecret,
  encryptSecret,
  generateCsrDer,
  generateP256KeyPair,
  type EncryptedSecret,
  type P256KeyPair,
} from "./acme-crypto.js";
import {
  createAcmeClient,
  type AcmeClient,
} from "./acme-client.js";

export const CERTIFICATES_NAMESPACE = "edge-certificates";
export const ACME_NAMESPACE = "edge-acme";
export const ACME_CHALLENGES_NAMESPACE = "edge-acme-challenges";
export const ACME_LEASES_NAMESPACE = "edge-acme-leases";

export interface ZelavisEdgeCertificateRecord {
  schemaVersion: 1;
  ref: string;
  hostname: string;
  sanHostnames: readonly string[];
  issuer: "acme" | "manual" | "self-signed";
  version: number;
  certPem: string;
  encryptedKey: EncryptedSecret;
  expiresAt: string;
  issuedAt: string;
  status: "valid" | "expired" | "revoked";
  updatedAt: string;
}

export interface ZelavisEdgeCertificateSummary {
  ref: string;
  hostname: string;
  sanHostnames: readonly string[];
  issuer: "acme" | "manual" | "self-signed";
  version: number;
  expiresAt: string;
  issuedAt: string;
  status: "valid" | "expired" | "revoked";
  updatedAt: string;
}

export interface ZelavisEdgeResolvedCertificate {
  ref: string;
  hostname: string;
  version: number;
  certPem: string;
  keyPem: string;
}

export interface AcmeChallengeStore {
  putHttpChallenge(
    token: string,
    keyAuthorization: string,
    expiresAt: Date,
  ): Promise<void>;
  getHttpChallenge(token: string): Promise<string | undefined>;
  deleteHttpChallenge(token: string): Promise<boolean>;
}

export interface OrderCertificateOptions {
  hostname: string;
  sanHostnames?: readonly string[];
  contactEmail?: string;
  directoryUrl?: string;
  forceRenew?: boolean;
}

export interface CheckRenewalsOptions {
  renewIfWithinDays?: number;
  directoryUrl?: string;
  contactEmail?: string;
}

export interface RenewalsResult {
  checked: number;
  renewed: readonly string[];
  failed: readonly { ref: string; error: string }[];
}

export interface ZelavisCertificateController {
  getCertificate(ref: string): Promise<ZelavisEdgeCertificateSummary | undefined>;
  resolveCertificate(ref: string): Promise<ZelavisEdgeResolvedCertificate | undefined>;
  listCertificates(): Promise<readonly ZelavisEdgeCertificateSummary[]>;
  orderCertificate(
    options: OrderCertificateOptions,
  ): Promise<ZelavisEdgeCertificateSummary>;
  importManualCertificate(options: {
    ref: string;
    hostname: string;
    sanHostnames?: readonly string[];
    certPem: string;
    keyPem: string;
  }): Promise<ZelavisEdgeCertificateSummary>;
  checkRenewals(options?: CheckRenewalsOptions): Promise<RenewalsResult>;
  challengeStore: AcmeChallengeStore;
}

export interface CreateZelavisCertificateControllerOptions {
  store: ZelavisSystemStore;
  masterSecret: string | Buffer;
  defaultDirectoryUrl?: string;
  customFetch?: typeof globalThis.fetch;
  now?: () => Date;
  challengeStore?: AcmeChallengeStore;
}

// ---------------------------------------------------------------------------
// Challenge Stores
// ---------------------------------------------------------------------------

export function createMemoryAcmeChallengeStore(): AcmeChallengeStore {
  const store = new Map<
    string,
    { keyAuthorization: string; expiresAt: number }
  >();

  return {
    async putHttpChallenge(
      token: string,
      keyAuthorization: string,
      expiresAt: Date,
    ): Promise<void> {
      store.set(token, {
        keyAuthorization,
        expiresAt: expiresAt.getTime(),
      });
    },

    async getHttpChallenge(token: string): Promise<string | undefined> {
      const entry = store.get(token);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(token);
        return undefined;
      }
      return entry.keyAuthorization;
    },

    async deleteHttpChallenge(token: string): Promise<boolean> {
      return store.delete(token);
    },
  };
}

export function createSystemStoreAcmeChallengeStore(
  systemStore: ZelavisSystemStore,
): AcmeChallengeStore {
  return {
    async putHttpChallenge(
      token: string,
      keyAuthorization: string,
      expiresAt: Date,
    ): Promise<void> {
      await systemStore.set(ACME_CHALLENGES_NAMESPACE, token, {
        keyAuthorization,
        expiresAt: expiresAt.toISOString(),
      });
    },

    async getHttpChallenge(token: string): Promise<string | undefined> {
      const record = await systemStore.get(ACME_CHALLENGES_NAMESPACE, token);
      if (!record || typeof record.value !== "object" || record.value === null) {
        return undefined;
      }
      const val = record.value as { keyAuthorization?: string; expiresAt?: string };
      if (!val.keyAuthorization || !val.expiresAt) {
        return undefined;
      }
      if (Date.now() > Date.parse(val.expiresAt)) {
        await systemStore.delete(ACME_CHALLENGES_NAMESPACE, token);
        return undefined;
      }
      return val.keyAuthorization;
    },

    async deleteHttpChallenge(token: string): Promise<boolean> {
      return systemStore.delete(ACME_CHALLENGES_NAMESPACE, token);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSummary(
  record: ZelavisEdgeCertificateRecord,
): ZelavisEdgeCertificateSummary {
  return {
    ref: record.ref,
    hostname: record.hostname,
    sanHostnames: record.sanHostnames,
    issuer: record.issuer,
    version: record.version,
    expiresAt: record.expiresAt,
    issuedAt: record.issuedAt,
    status: record.status,
    updatedAt: record.updatedAt,
  };
}

function parseCertificateDates(certPem: string): {
  issuedAt: string;
  expiresAt: string;
} {
  try {
    const x509 = new X509Certificate(certPem);
    return {
      issuedAt: new Date(x509.validFrom).toISOString(),
      expiresAt: new Date(x509.validTo).toISOString(),
    };
  } catch {
    const now = Date.now();
    return {
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 90 * 24 * 60 * 60 * 1000).toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Controller Factory
// ---------------------------------------------------------------------------

export function createZelavisCertificateController(
  options: CreateZelavisCertificateControllerOptions,
): ZelavisCertificateController {
  const {
    store,
    masterSecret,
    defaultDirectoryUrl = "https://acme-v02.api.letsencrypt.org/directory",
    customFetch = globalThis.fetch,
    now = () => new Date(),
  } = options;

  const challengeStore =
    options.challengeStore ?? createMemoryAcmeChallengeStore();

  async function getStoredRecord(
    ref: string,
  ): Promise<ZelavisEdgeCertificateRecord | undefined> {
    const record = await store.get(CERTIFICATES_NAMESPACE, ref);
    if (!record || typeof record.value !== "object" || record.value === null) {
      return undefined;
    }
    return record.value as unknown as ZelavisEdgeCertificateRecord;
  }

  async function getOrCreateAcmeAccount(
    directoryUrl: string,
    contactEmail?: string,
  ): Promise<{ client: AcmeClient; accountUrl: string }> {
    const accountRecord = await store.get(ACME_NAMESPACE, "default");
    let keyPair: P256KeyPair;
    let accountUrl: string | undefined;

    if (
      accountRecord &&
      typeof accountRecord.value === "object" &&
      accountRecord.value !== null
    ) {
      const val = accountRecord.value as unknown as {
        encryptedKey: EncryptedSecret;
        accountUrl: string;
      };
      const keyPem = decryptSecret(val.encryptedKey, masterSecret);
      const { createPrivateKey } = await import("node:crypto");
      const priv = createPrivateKey(keyPem);
      const { createPublicKey } = await import("node:crypto");
      const pub = createPublicKey(priv);
      keyPair = {
        privateKey: priv,
        publicKey: pub,
        privateKeyPem: keyPem,
        publicKeyPem: pub.export({ type: "spki", format: "pem" }).toString(),
      };
      accountUrl = val.accountUrl;
    } else {
      keyPair = generateP256KeyPair();
    }

    const client = createAcmeClient({
      directoryUrl,
      accountKey: keyPair,
      accountUrl,
      fetch: customFetch,
    });

    if (!accountUrl) {
      const details = await client.createOrGetAccount({
        contactEmail,
        termsOfServiceAgreed: true,
      });
      accountUrl = details.accountUrl;
      const encryptedKey = encryptSecret(keyPair.privateKeyPem, masterSecret);
      await store.set(ACME_NAMESPACE, "default", {
        directoryUrl,
        accountUrl,
        encryptedKey: encryptedKey as unknown as ZelavisSystemStoreValue,
        createdAt: now().toISOString(),
      });
    }

    return { client, accountUrl };
  }

  return {
    challengeStore,

    async getCertificate(
      ref: string,
    ): Promise<ZelavisEdgeCertificateSummary | undefined> {
      const record = await getStoredRecord(ref);
      return record ? toSummary(record) : undefined;
    },

    async resolveCertificate(
      ref: string,
    ): Promise<ZelavisEdgeResolvedCertificate | undefined> {
      const record = await getStoredRecord(ref);
      if (!record) return undefined;

      const keyPem = decryptSecret(record.encryptedKey, masterSecret);
      return {
        ref: record.ref,
        hostname: record.hostname,
        version: record.version,
        certPem: record.certPem,
        keyPem,
      };
    },

    async listCertificates(): Promise<readonly ZelavisEdgeCertificateSummary[]> {
      const records = await store.list(CERTIFICATES_NAMESPACE);
      return records
        .map((r) => r.value as unknown as ZelavisEdgeCertificateRecord)
        .filter((val): val is ZelavisEdgeCertificateRecord => Boolean(val?.ref))
        .map(toSummary);
    },

    async orderCertificate(
      orderOptions: OrderCertificateOptions,
    ): Promise<ZelavisEdgeCertificateSummary> {
      const hostname = orderOptions.hostname.trim().toLowerCase();
      const sanHostnames = (orderOptions.sanHostnames ?? []).map((s) =>
        s.trim().toLowerCase(),
      );
      const ref = `certificate:${hostname}`;
      const directoryUrl = orderOptions.directoryUrl ?? defaultDirectoryUrl;

      // 1. Check existing cert
      const existing = await getStoredRecord(ref);
      if (existing && !orderOptions.forceRenew) {
        const expiresTime = Date.parse(existing.expiresAt);
        const daysRemaining = (expiresTime - now().getTime()) / (1000 * 60 * 60 * 24);
        if (daysRemaining > 30 && existing.status === "valid") {
          return toSummary(existing);
        }
      }

      // 2. Fenced lease acquisition
      const leaseKey = `lease:${hostname}`;
      const leaseDurationMs = 300000; // 5 minutes
      const leaseRecord = await store.get(ACME_LEASES_NAMESPACE, leaseKey);
      const currentTime = now().getTime();

      if (leaseRecord && typeof leaseRecord.value === "object" && leaseRecord.value !== null) {
        const lease = leaseRecord.value as { expiresAt: string; owner: string };
        if (Date.parse(lease.expiresAt) > currentTime) {
          // Lease active by another process; return existing if available
          if (existing) return toSummary(existing);
          throw new Error(
            `ACME certificate order for "${hostname}" is currently in progress by another controller.`,
          );
        }
      }

      const leaseExpiresAt = new Date(currentTime + leaseDurationMs).toISOString();
      await store.set(ACME_LEASES_NAMESPACE, leaseKey, {
        owner: "controller",
        expiresAt: leaseExpiresAt,
      });

      try {
        // 3. Obtain ACME Client
        const { client } = await getOrCreateAcmeAccount(
          directoryUrl,
          orderOptions.contactEmail,
        );

        // 4. Create Order
        const allIdentifiers = [
          hostname,
          ...sanHostnames.filter((s) => s !== hostname),
        ];
        const order = await client.createOrder(allIdentifiers);

        // 5. Complete HTTP-01 Challenges
        for (const authzUrl of order.authorizations) {
          const authz = await client.getAuthorization(authzUrl);
          if (authz.status === "valid") continue;

          const httpChallenge = authz.challenges.find((c) => c.type === "http-01");
          if (!httpChallenge) {
            throw new Error(
              `ACME server did not offer http-01 challenge for ${authz.identifier.value}`,
            );
          }

          const keyAuthorization = `${httpChallenge.token}.${client.getAccountThumbprint()}`;
          const challengeExpiresAt = new Date(currentTime + 600000); // 10m TTL

          await challengeStore.putHttpChallenge(
            httpChallenge.token,
            keyAuthorization,
            challengeExpiresAt,
          );

          try {
            await client.notifyChallenge(httpChallenge.url);
            await client.pollAuthorization(authzUrl, { maxWaitMs: 30000 });
          } finally {
            await challengeStore.deleteHttpChallenge(httpChallenge.token);
          }
        }

        // 6. Generate Certificate Key Pair & CSR
        const certKeyPair = generateP256KeyPair();
        const csrDer = generateCsrDer({
          keyPair: certKeyPair,
          commonName: hostname,
          sanList: sanHostnames,
        });

        // 7. Finalize Order & Poll
        const finalized = await client.finalizeOrder(order.finalize, csrDer);
        const readyOrder =
          finalized.status === "valid" && finalized.certificate
            ? finalized
            : await client.pollOrder(order.orderUrl, { maxWaitMs: 30000 });

        if (!readyOrder.certificate) {
          throw new Error("ACME order succeeded but returned no certificate URL.");
        }

        // 8. Download Certificate
        const certPem = await client.downloadCertificate(readyOrder.certificate);
        const dates = parseCertificateDates(certPem);

        // 9. Encrypt Key & Persist Record
        const encryptedKey = encryptSecret(
          certKeyPair.privateKeyPem,
          masterSecret,
        );
        const version = (existing?.version ?? 0) + 1;

        const newRecord: ZelavisEdgeCertificateRecord = {
          schemaVersion: 1,
          ref,
          hostname,
          sanHostnames,
          issuer: "acme",
          version,
          certPem,
          encryptedKey,
          expiresAt: dates.expiresAt,
          issuedAt: dates.issuedAt,
          status: "valid",
          updatedAt: now().toISOString(),
        };

        await store.set(CERTIFICATES_NAMESPACE, ref, newRecord as any);
        return toSummary(newRecord);
      } finally {
        await store.delete(ACME_LEASES_NAMESPACE, leaseKey);
      }
    },

    async importManualCertificate(manualOptions): Promise<ZelavisEdgeCertificateSummary> {
      const { ref, hostname, certPem, keyPem, sanHostnames = [] } = manualOptions;
      const dates = parseCertificateDates(certPem);
      const encryptedKey = encryptSecret(keyPem, masterSecret);
      const existing = await getStoredRecord(ref);
      const version = (existing?.version ?? 0) + 1;

      const record: ZelavisEdgeCertificateRecord = {
        schemaVersion: 1,
        ref,
        hostname: hostname.toLowerCase(),
        sanHostnames: sanHostnames.map((s) => s.toLowerCase()),
        issuer: "manual",
        version,
        certPem,
        encryptedKey,
        expiresAt: dates.expiresAt,
        issuedAt: dates.issuedAt,
        status: "valid",
        updatedAt: now().toISOString(),
      };

      await store.set(CERTIFICATES_NAMESPACE, ref, record as any);
      return toSummary(record);
    },

    async checkRenewals(
      checkOptions = {},
    ): Promise<RenewalsResult> {
      const renewIfWithinDays = checkOptions.renewIfWithinDays ?? 30;
      const thresholdMs = renewIfWithinDays * 24 * 60 * 60 * 1000;
      const records = await store.list(CERTIFICATES_NAMESPACE);
      const renewed: string[] = [];
      const failed: { ref: string; error: string }[] = [];

      for (const r of records) {
        const cert = r.value as unknown as ZelavisEdgeCertificateRecord;
        if (!cert || cert.issuer !== "acme" || cert.status !== "valid") {
          continue;
        }

        const expiresTime = Date.parse(cert.expiresAt);
        const timeUntilExpiry = expiresTime - now().getTime();

        if (timeUntilExpiry < thresholdMs) {
          try {
            await this.orderCertificate({
              hostname: cert.hostname,
              sanHostnames: cert.sanHostnames,
              directoryUrl: checkOptions.directoryUrl,
              contactEmail: checkOptions.contactEmail,
              forceRenew: true,
            });
            renewed.push(cert.ref);
          } catch (error) {
            failed.push({
              ref: cert.ref,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return {
        checked: records.length,
        renewed,
        failed,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP-01 Challenge Service
// ---------------------------------------------------------------------------

export function createAcmeChallengeService(
  challengeStore: AcmeChallengeStore,
): ZelavisRuntimeService {
  const route: ZelavisServerRoute<unknown> = {
    id: "zelavis.edge.acme-challenge",
    method: "GET",
    path: "/.well-known/acme-challenge/:token",
    handler: async ({ params }) => {
      const token = params?.token;
      if (typeof token !== "string" || !token) {
        return { status: 404, body: "Not found" };
      }

      const keyAuthorization = await challengeStore.getHttpChallenge(token);
      if (!keyAuthorization) {
        return { status: 404, body: "Not found" };
      }

      return {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
        body: keyAuthorization,
      };
    },
  };

  return {
    name: "zelavis-acme-challenge",
    basePath: "/",
    service: {},
    api: { v1: [route] },
  };
}
