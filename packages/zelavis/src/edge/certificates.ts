import { Effect } from "effect";
import { evaluate, present, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
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
  projectDomainId?: string;
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
    hostname?: string,
  ): Promise<void>;
  getHttpChallenge(token: string, hostname?: string): Promise<string | undefined>;
  deleteHttpChallenge(token: string): Promise<boolean>;
}

export interface OrderCertificateOptions {
  hostname: string;
  sanHostnames?: readonly string[];
  contactEmail?: string;
  directoryUrl?: string;
  forceRenew?: boolean;
  signal?: AbortSignal;
  projectDomainId?: string;
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
  retireProjectCertificate(ref: string, domainId: string): Promise<void>;
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
    { keyAuthorization: string; expiresAt: number; hostname?: string }
  >();

  return {
    putHttpChallenge(
      token: string,
      keyAuthorization: string,
      expiresAt: Date,
      hostname?: string,
    ): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
      store.set(token, {
        keyAuthorization,
        expiresAt: expiresAt.getTime(),
        hostname,
      });
    }));
  },

    getHttpChallenge(token: string, hostname?: string): Promise<string | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<string | undefined, IntegrationFailure> {
      const entry = store.get(token);
      if (!entry || (hostname && entry.hostname && entry.hostname !== hostname)) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(token);
        return undefined;
      }
      return entry.keyAuthorization;
    }));
  },

    deleteHttpChallenge(token: string): Promise<boolean> {
    return present(integration(() => store.delete(token)));
  },
  };
}

export function createSystemStoreAcmeChallengeStore(
  systemStore: ZelavisSystemStore,
): AcmeChallengeStore {
  return {
    putHttpChallenge(
      token: string,
      keyAuthorization: string,
      expiresAt: Date,
      hostname?: string,
    ): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
      (yield* integrationValue(systemStore.set(ACME_CHALLENGES_NAMESPACE, token, {
        keyAuthorization,
        expiresAt: expiresAt.toISOString(),
        ...(hostname ? { hostname } : {}),
      })));
    }));
  },

    getHttpChallenge(token: string, hostname?: string): Promise<string | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<string | undefined, IntegrationFailure> {
      const record = (yield* integrationValue(systemStore.get(ACME_CHALLENGES_NAMESPACE, token)));
      if (!record || typeof record.value !== "object" || record.value === null) {
        return undefined;
      }
      const val = record.value as { keyAuthorization?: string; expiresAt?: string; hostname?: string };
      if (!val.keyAuthorization || !val.expiresAt || (hostname && val.hostname && val.hostname !== hostname)) {
        return undefined;
      }
      if (Date.now() > Date.parse(val.expiresAt)) {
        (yield* integrationValue(systemStore.delete(ACME_CHALLENGES_NAMESPACE, token)));
        return undefined;
      }
      return val.keyAuthorization;
    }));
  },

    deleteHttpChallenge(token: string): Promise<boolean> {
    return present(integration(() => systemStore.delete(ACME_CHALLENGES_NAMESPACE, token)));
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

  function getStoredRecord(
    ref: string,
  ): Promise<ZelavisEdgeCertificateRecord | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeCertificateRecord | undefined, IntegrationFailure> {
    const record = (yield* integrationValue(store.get(CERTIFICATES_NAMESPACE, ref)));
    if (!record || typeof record.value !== "object" || record.value === null) {
      return undefined;
    }
    return record.value as unknown as ZelavisEdgeCertificateRecord;
  }));
  }

  function getOrCreateAcmeAccount(
    directoryUrl: string,
    contactEmail?: string,
    signal?: AbortSignal,
  ): Promise<{ client: AcmeClient; accountUrl: string }> {
    return present(Effect.gen(function* (): Effect.fn.Return<{ client: AcmeClient; accountUrl: string }, IntegrationFailure> {
    const accountRecord = (yield* integrationValue(store.get(ACME_NAMESPACE, "default")));
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
      const { createPrivateKey } = (yield* integrationValue(import("node:crypto")));
      const priv = createPrivateKey(keyPem);
      const { createPublicKey } = (yield* integrationValue(import("node:crypto")));
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
      fetch: (input, init) => customFetch(input, { ...init, signal: signal && init?.signal
        ? AbortSignal.any([signal, init.signal]) : signal ?? init?.signal ?? null }),
    });

    if (!accountUrl) {
      const details = (yield* integrationValue(client.createOrGetAccount({
        contactEmail,
        termsOfServiceAgreed: true,
      })));
      accountUrl = details.accountUrl;
      const encryptedKey = encryptSecret(keyPair.privateKeyPem, masterSecret);
      (yield* integrationValue(store.set(ACME_NAMESPACE, "default", {
        directoryUrl,
        accountUrl,
        encryptedKey: encryptedKey as unknown as ZelavisSystemStoreValue,
        createdAt: now().toISOString(),
      })));
    }

    return { client, accountUrl };
  }));
  }

  return {
    challengeStore,

    getCertificate(
      ref: string,
    ): Promise<ZelavisEdgeCertificateSummary | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeCertificateSummary | undefined, IntegrationFailure> {
      const record = (yield* integrationValue(getStoredRecord(ref)));
      return record ? toSummary(record) : undefined;
    }));
  },

    resolveCertificate(
      ref: string,
    ): Promise<ZelavisEdgeResolvedCertificate | undefined> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeResolvedCertificate | undefined, IntegrationFailure> {
      const record = (yield* integrationValue(getStoredRecord(ref)));
      if (!record) return undefined;

      const keyPem = decryptSecret(record.encryptedKey, masterSecret);
      return {
        ref: record.ref,
        hostname: record.hostname,
        version: record.version,
        certPem: record.certPem,
        keyPem,
      };
    }));
  },

    listCertificates(): Promise<readonly ZelavisEdgeCertificateSummary[]> {
    return present(Effect.gen(function* (): Effect.fn.Return<readonly ZelavisEdgeCertificateSummary[], IntegrationFailure> {
      const records = (yield* integrationValue(store.list(CERTIFICATES_NAMESPACE)));
      return (yield* integrationValue(records
        .map((r) => r.value as unknown as ZelavisEdgeCertificateRecord)
        .filter((val): val is ZelavisEdgeCertificateRecord => Boolean(val?.ref))
        .map(toSummary)));
    }));
  },

    orderCertificate(
      orderOptions: OrderCertificateOptions,
    ): Promise<ZelavisEdgeCertificateSummary> {
      return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeCertificateSummary, IntegrationFailure> {
      yield* evaluate(() => orderOptions.signal?.throwIfAborted());
      const hostname = orderOptions.hostname.trim().toLowerCase();
      const sanHostnames = (orderOptions.sanHostnames ?? []).map((s) =>
        s.trim().toLowerCase(),
      );
      const ref = `certificate:${hostname}`;
      const directoryUrl = orderOptions.directoryUrl ?? defaultDirectoryUrl;

      // 1. Check existing cert
      const observed = yield* integration(() => store.get(CERTIFICATES_NAMESPACE, ref));
      const existing = observed?.value as unknown as ZelavisEdgeCertificateRecord | undefined;
      if (existing && !orderOptions.forceRenew) {
        const expiresTime = Date.parse(existing.expiresAt);
        const daysRemaining = (expiresTime - now().getTime()) / (1000 * 60 * 60 * 24);
        if (daysRemaining > 30 && existing.status === "valid") {
          return toSummary(existing);
        }
      }

      // One lease per hostname for both new issuance and renewal.
      const leaseKey = `lease:${hostname}`;
      const leaseRecord = yield* integration(() => store.get(ACME_LEASES_NAMESPACE, leaseKey));
      const currentTime = now().getTime();
      if (leaseRecord && typeof leaseRecord.value === "object" && leaseRecord.value !== null &&
          "expiresAt" in leaseRecord.value && typeof leaseRecord.value.expiresAt === "string" &&
          Date.parse(leaseRecord.value.expiresAt) > currentTime) {
        throw new Error(`ACME certificate order for "${hostname}" is currently in progress.`);
      }
      const lease = { owner: crypto.randomUUID(), expiresAt: new Date(currentTime + 300_000).toISOString() };
      const claim = leaseRecord
        ? yield* integration(() => store.compareAndSet(ACME_LEASES_NAMESPACE, leaseKey, leaseRecord.updatedAt, lease, leaseRecord.value))
        : (yield* integration(() => store.setIfAbsent(ACME_LEASES_NAMESPACE, leaseKey, lease))).record;
      if (!claim || !claim.value || typeof claim.value !== "object" || !("owner" in claim.value) || claim.value.owner !== lease.owner) {
        throw new Error(`ACME certificate order for "${hostname}" is currently in progress.`);
      }

      return yield* Effect.gen(function* () {
        // 3. Obtain ACME Client
        const { client } = yield* integrationValue(getOrCreateAcmeAccount(
          directoryUrl,
          orderOptions.contactEmail,
          orderOptions.signal,
        ));

        // 4. Create Order
        const allIdentifiers = [
          hostname,
          ...sanHostnames.filter((s) => s !== hostname),
        ];
        const order = yield* integrationValue(client.createOrder(allIdentifiers));

        // 5. Complete HTTP-01 Challenges
        for (const authzUrl of order.authorizations) {
          const authz = yield* integrationValue(client.getAuthorization(authzUrl));
          if (authz.status === "valid") continue;

          if (!allIdentifiers.includes(authz.identifier.value)) throw new Error("ACME returned an unexpected hostname.");
          const httpChallenge = authz.challenges.find((c) => c.type === "http-01");
          if (!httpChallenge) {
            throw new Error(
              `ACME server did not offer http-01 challenge for ${authz.identifier.value}`,
            );
          }

          const keyAuthorization = `${httpChallenge.token}.${client.getAccountThumbprint()}`;
          const challengeExpiresAt = new Date(currentTime + 600000); // 10m TTL

          yield* integrationValue(challengeStore.putHttpChallenge(
            httpChallenge.token,
            keyAuthorization,
            challengeExpiresAt,
            authz.identifier.value,
          ));

          yield* Effect.gen(function* () {
            yield* integrationValue(client.notifyChallenge(httpChallenge.url));
            yield* integrationValue(client.pollAuthorization(authzUrl, { maxWaitMs: 30000 }));
          }).pipe(Effect.ensuring(integration(() => challengeStore.deleteHttpChallenge(httpChallenge.token)).pipe(Effect.orDie)));
        }

        // 6. Generate Certificate Key Pair & CSR
        const certKeyPair = generateP256KeyPair();
        const csrDer = generateCsrDer({
          keyPair: certKeyPair,
          commonName: hostname,
          sanList: sanHostnames,
        });

        // 7. Finalize Order & Poll
        const finalized = yield* integrationValue(client.finalizeOrder(order.finalize, csrDer));
        const readyOrder =
          finalized.status === "valid" && finalized.certificate
            ? finalized
            : yield* integrationValue(client.pollOrder(order.orderUrl, { maxWaitMs: 30000 }));

        if (!readyOrder.certificate) {
          throw new Error("ACME order succeeded but returned no certificate URL.");
        }

        // 8. Download Certificate
        const certPem = yield* integrationValue(client.downloadCertificate(readyOrder.certificate));
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
          ...((orderOptions.projectDomainId ?? existing?.projectDomainId) ? {
            projectDomainId: (orderOptions.projectDomainId ?? existing?.projectDomainId)!,
          } : {}),
        };

        yield* evaluate(() => orderOptions.signal?.throwIfAborted());
        const currentLease = yield* integration(() => store.get(ACME_LEASES_NAMESPACE, leaseKey));
        if (currentLease?.updatedAt !== claim.updatedAt || JSON.stringify(currentLease.value) !== JSON.stringify(claim.value)) {
          throw new Error("The ACME certificate order lost its lease.");
        }
        const value = { ...newRecord, encryptedKey: { ...newRecord.encryptedKey } };
        const saved = observed
          ? yield* integration(() => {
              orderOptions.signal?.throwIfAborted();
              return store.compareAndSet(CERTIFICATES_NAMESPACE, ref, observed.updatedAt, value, observed.value);
            })
          : (yield* integration(() => {
              orderOptions.signal?.throwIfAborted();
              return store.setIfAbsent(CERTIFICATES_NAMESPACE, ref, value);
            })).created;
        if (!saved) throw new Error("The certificate changed during the ACME order.");
        return toSummary(newRecord);
      }).pipe(Effect.ensuring(integration(() => store.compareAndDelete(ACME_LEASES_NAMESPACE, leaseKey, claim.updatedAt, claim.value)).pipe(Effect.orDie)));
      }));
    },

    importManualCertificate(manualOptions): Promise<ZelavisEdgeCertificateSummary> {
    return present(Effect.gen(function* (): Effect.fn.Return<ZelavisEdgeCertificateSummary, IntegrationFailure> {
      const { ref, hostname, certPem, keyPem, sanHostnames = [] } = manualOptions;
      const dates = parseCertificateDates(certPem);
      const encryptedKey = encryptSecret(keyPem, masterSecret);
      const existing = (yield* integrationValue(getStoredRecord(ref)));
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

      (yield* integrationValue(store.set(CERTIFICATES_NAMESPACE, ref, record as any)));
      return (yield* integrationValue(toSummary(record)));
    }));
  },

    retireProjectCertificate(ref, domainId) {
      return present(Effect.gen(function* () {
        for (let attempt = 0; attempt < 4; attempt++) {
          const record = yield* integration(() => store.get(CERTIFICATES_NAMESPACE, ref));
          const certificate = record?.value as unknown as ZelavisEdgeCertificateRecord | undefined;
          if (!record || certificate?.issuer !== "acme" || certificate.projectDomainId !== domainId) return;
          if (yield* integration(() => store.compareAndDelete(CERTIFICATES_NAMESPACE, ref, record.updatedAt, record.value))) return;
        }
        throw new Error("The Project certificate changed during retirement.");
      }));
    },

    checkRenewals(
      checkOptions = {},
    ): Promise<RenewalsResult> {
      const self = this;
      return present(Effect.gen(function* (): Effect.fn.Return<RenewalsResult, IntegrationFailure> {
      const renewIfWithinDays = checkOptions.renewIfWithinDays ?? 30;
      const thresholdMs = renewIfWithinDays * 24 * 60 * 60 * 1000;
      const records = yield* integrationValue(store.list(CERTIFICATES_NAMESPACE));
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
          yield* integration(() => self.orderCertificate({
            hostname: cert.hostname,
            sanHostnames: cert.sanHostnames,
            directoryUrl: checkOptions.directoryUrl,
            contactEmail: checkOptions.contactEmail,
            forceRenew: true,
            signal: AbortSignal.timeout(90_000),
          })).pipe(
            Effect.tap(() => Effect.sync(() => { renewed.push(cert.ref); })),
            Effect.catch((failure) => Effect.sync(() => {
              const error = unwrapFailure(failure);
              failed.push({
                ref: cert.ref,
                error: error instanceof Error ? error.message : String(error),
              });
            })),
          );
        }
      }

      return {
        checked: records.length,
        renewed,
        failed,
      };
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP-01 Challenge Service
// ---------------------------------------------------------------------------

export function respondToAcmeChallenge(challengeStore: AcmeChallengeStore, token: string, hostname: string) {
  return present(Effect.gen(function* () {
    const value = yield* integration(() => challengeStore.getHttpChallenge(token, hostname));
    return value
      ? { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: value }
      : { status: 404, body: "Not found" };
  }));
}

export function createAcmeChallengeService(
  challengeStore: AcmeChallengeStore,
): ZelavisRuntimeService {
  const route: ZelavisServerRoute<unknown> = {
    id: "zelavis.edge.acme-challenge",
    method: "GET",
    path: "/.well-known/acme-challenge/:token",
    handler: ({ params, request }) => {
      const token = params?.token;
      if (typeof token !== "string" || !token) return { status: 404, body: "Not found" };
      return respondToAcmeChallenge(challengeStore, token, new URL(request.url).hostname.toLowerCase().replace(/\.$/, ""));
    },
  };

  return {
    name: "zelavis-acme-challenge",
    basePath: "/",
    service: {},
    api: { v1: [route] },
  };
}
