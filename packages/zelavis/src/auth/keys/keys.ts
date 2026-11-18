/**
 * Per-runtime access-token signing keys.
 *
 * The active key is an ES256 key pair whose private half is stored sealed with
 * the runtime's master secret and held in memory once opened. Rotation retires
 * the active key and creates another; a retired key stays published until the
 * longest access token it could have signed has expired, then a sweep removes
 * it. Verification keys are cached in memory and reloaded when a token names a
 * key id the cache lacks, so a request reads nothing from the database for its
 * signature.
 */
import * as Effect from "effect/Effect";
import { type CryptoKey, type JWTVerifyGetKey, SignJWT, calculateJwkThumbprint, createLocalJWKSet, exportJWK, generateKeyPair, importJWK, jwtVerify } from "jose";
import { integration, unwrapFailure } from "../../core/runtime/effect-boundary.js";
import { parseJsonObject } from "../../core/json-validation.js";
import { decryptSecret, encryptSecret } from "../../edge/acme-crypto.js";
import type { AuthFailure } from "../core/errors.js";
import type { AuthKeys } from "../core/context.js";
import { projectAuthIssuer } from "../core/audience.js";
import { MAX_ACCESS_TOKEN_TTL_SECONDS } from "../lib/ttl.js";
import { NO_REQUEST, type AuthRuntime, type AuthSweep, SWEEP_BATCH, defineSweep } from "../runtime/index.js";
import { type PublicJwk, keysTables } from "./tables.js";

/** The `aud` claim of every access token. */
export const AUDIENCE = "zelavis-auth";

/** How soon a token naming an unknown key id may make the verifier reload its keys. */
const RELOAD_MIN_INTERVAL_MS = 5000;
const RETIRED_KEY_RETENTION_MS = MAX_ACCESS_TOKEN_TTL_SECONDS * 1000;

/** What the signature and the times of an access token say. A live session is a separate question. */
export type AccessTokenCheck =
  | { readonly kind: "valid"; readonly sub: string }
  | { readonly kind: "expired" }
  | { readonly kind: "invalid" };

export interface AuthKeysAdmin extends AuthKeys {
  /** Creates the key set and the first key when there are none, and loads the keys. Runs when Auth starts. */
  readonly ensure: () => Effect.Effect<void, AuthFailure>;
  /** The `iss` claim of this runtime's tokens; known once `ensure` has run. */
  readonly issuer: () => string;
  readonly verify: (token: string) => Effect.Effect<AccessTokenCheck>;
  /** The keys that verify tokens now: the active one and the retired ones still within retention. */
  readonly jwks: () => Effect.Effect<{ readonly keys: ReadonlyArray<PublicJwk> }>;
  /** Retires the active key and creates another. */
  readonly rotate: () => Effect.Effect<{ readonly kid: string }, AuthFailure>;
  /** Removes retired keys past retention. Part of `start`. */
  readonly sweeps: ReadonlyArray<AuthSweep<AuthRuntime>>;
}

export interface CreateAuthKeysOptions {
  readonly runtime: AuthRuntime;
  readonly masterSecret: string;
  readonly role: "platform" | "project";
  readonly projectId?: string | undefined;
  /** Overrides the derived issuer. */
  readonly issuer?: string | undefined;
  readonly clock?: (() => number) | undefined;
}

const sealingKey = (masterSecret: string) => `${masterSecret}\u0000zelavis.auth.signing`;

const randomKeySetId = () => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

// Generating, exporting and importing a key of a fixed type cannot fail on valid input; a failure is a defect.
const crypt = <A>(operation: () => Promise<A>): Effect.Effect<A> => integration(operation).pipe(Effect.orDie);

export function createAuthKeys(options: CreateAuthKeysOptions): AuthKeysAdmin {
  const clock = options.clock ?? Date.now;
  const seal = sealingKey(options.masterSecret);
  let issuer: string | undefined;
  let active: { readonly kid: string; readonly key: CryptoKey } | undefined;
  let verifier: { readonly resolve: JWTVerifyGetKey; readonly kids: ReadonlySet<string>; readonly loadedAt: number } | undefined;

  const published = (now: number) => (row: { readonly retiredAt?: number | undefined }) => row.retiredAt === undefined || row.retiredAt + RETIRED_KEY_RETENTION_MS > now;

  // A handful of rows: a read past the transaction's limits is a defect.
  const listRows = options.runtime.query(NO_REQUEST, (tx) => tx.db.query(keysTables.signingKeys).collect()).pipe(Effect.orDie);

  const loadVerifier = Effect.gen(function* () {
    const rows = yield* listRows;
    const now = clock();
    const keys = rows.filter(published(now)).map((row) => row.publicJwk);
    verifier = { resolve: createLocalJWKSet({ keys }), kids: new Set(keys.map((key) => key.kid)), loadedAt: now };
  });

  const createKey = Effect.fn("auth.keys.createKey")(function* () {
    const pair = yield* crypt(() => generateKeyPair("ES256", { extractable: true }));
    const jwk = yield* crypt(() => exportJWK(pair.publicKey));
    const privateJwk = yield* crypt(() => exportJWK(pair.privateKey));
    const kid = yield* crypt(() => calculateJwkThumbprint(jwk));
    const publicJwk = { ...jwk, kid, alg: "ES256", use: "sig" } as PublicJwk;
    return { kid, publicJwk, sealedPrivateJwk: { ...encryptSecret(JSON.stringify(privateJwk), seal) }, key: pair.privateKey };
  });

  const open = Effect.fn("auth.keys.open")(function* (row: { readonly kid: string; readonly sealedPrivateJwk: Parameters<typeof decryptSecret>[0] }) {
    const privateJwk = parseJsonObject(decryptSecret(row.sealedPrivateJwk, seal));
    return { kid: row.kid, key: (yield* crypt(() => importJWK(privateJwk, "ES256"))) as CryptoKey };
  });

  const ensure = Effect.fn("auth.keys.ensure")(function* () {
    const created = yield* createKey();
    const result = yield* options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      let keySet = yield* tx.db.query(keysTables.keySet).first();
      const keySetId = keySet?.keySetId ?? randomKeySetId();
      if (keySet === null) yield* tx.db.insert(keysTables.keySet, { keySetId });
      const rows = yield* tx.db.query(keysTables.signingKeys).collect();
      const current = rows.find((row) => row.retiredAt === undefined);
      if (current !== undefined) return { keySetId, row: current, fresh: false as const };
      const { key: _key, ...stored } = created;
      yield* tx.db.insert(keysTables.signingKeys, { ...stored, createdAt: tx.now });
      return { keySetId, row: { ...stored, createdAt: tx.now }, fresh: true as const };
    }));
    active = result.fresh ? { kid: created.kid, key: created.key } : yield* open(result.row);
    issuer = options.issuer !== undefined && options.issuer !== "platform"
      ? options.issuer
      : options.role === "platform" ? `zelavis:platform:${result.keySetId}` : projectAuthIssuer(options.projectId ?? "");
    yield* loadVerifier;
  });

  const rotate = Effect.fn("auth.keys.rotate")(function* () {
    const created = yield* createKey();
    yield* options.runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const rows = yield* tx.db.query(keysTables.signingKeys).collect();
      for (const row of rows) if (row.retiredAt === undefined) yield* tx.db.patch(keysTables.signingKeys, row._id, { retiredAt: tx.now });
      const { key: _key, ...stored } = created;
      yield* tx.db.insert(keysTables.signingKeys, { ...stored, createdAt: tx.now });
    }));
    active = { kid: created.kid, key: created.key };
    yield* loadVerifier;
    return { kid: created.kid };
  });

  const sign: AuthKeys["sign"] = ({ claims, expiresInSeconds }) => Effect.gen(function* () {
    if (active === undefined || issuer === undefined) return yield* Effect.die(new Error("Auth signing keys are not loaded; call ensure() first."));
    const issuedAt = Math.floor(clock() / 1000);
    const { kid, key } = active;
    return yield* crypt(() => new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(issuer as string)
      .setAudience(AUDIENCE)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + expiresInSeconds)
      .sign(key));
  });

  const verifyOnce = (token: string) => integration(() => {
    if (verifier === undefined || issuer === undefined) throw new Error("Auth signing keys are not loaded.");
    return jwtVerify(token, verifier.resolve, { issuer, audience: AUDIENCE, algorithms: ["ES256"], currentDate: new Date(clock()) });
  });

  const classify = (failure: unknown): "expired" | "unknown-key" | "invalid" => {
    const code = (unwrapFailure(failure) as { readonly code?: unknown } | null)?.code;
    return code === "ERR_JWT_EXPIRED" ? "expired" : code === "ERR_JWKS_NO_MATCHING_KEY" ? "unknown-key" : "invalid";
  };

  const verify = Effect.fn("auth.keys.verify")(function* (token: string) {
    let attempt = yield* Effect.result(verifyOnce(token));
    if (attempt._tag === "Failure" && classify(attempt.failure) === "unknown-key" && verifier !== undefined && clock() - verifier.loadedAt >= RELOAD_MIN_INTERVAL_MS) {
      yield* loadVerifier;
      attempt = yield* Effect.result(verifyOnce(token));
    }
    if (attempt._tag === "Success") {
      const sub = attempt.success.payload.sub;
      return typeof sub === "string" && sub !== "" ? { kind: "valid", sub } as const : { kind: "invalid" } as const;
    }
    return classify(attempt.failure) === "expired" ? { kind: "expired" } as const : { kind: "invalid" } as const;
  });

  const jwks = Effect.fn("auth.keys.jwks")(function* () {
    const rows = yield* listRows;
    return { keys: rows.filter(published(clock())).map((row) => row.publicJwk) };
  });

  const retiredSweep = defineSweep<AuthRuntime>({
    name: "keys.retired",
    everyMs: 10 * 60_000,
    run: (runtime) => runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const rows = yield* tx.db.query(keysTables.signingKeys).collect();
      let removed = 0;
      for (const row of rows) {
        if (removed >= SWEEP_BATCH) break;
        if (row.retiredAt !== undefined && row.retiredAt + RETIRED_KEY_RETENTION_MS <= tx.now) {
          yield* tx.db.delete(keysTables.signingKeys, row._id);
          removed += 1;
        }
      }
      return removed;
    })),
  });

  return {
    ensure,
    issuer: () => issuer ?? "",
    sign,
    verify,
    jwks,
    rotate,
    sweeps: [retiredSweep],
  };
}
