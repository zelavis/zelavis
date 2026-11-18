import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "../edge/acme-crypto.js";
import type { ZelavisSystemStore } from "../system-store.js";
import type { AuthApi } from "../auth/create-auth.js";
import type { ZelavisPrincipal } from "../core/index.js";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";
import { NO_REQUEST } from "../auth/runtime/index.js";
import { grantServicePrincipal, retireServicePrincipal } from "../auth/serviceAccounts/servicePrincipals.js";
import type { ZelavisServiceRegistryEntry } from "../service.js";

const NAMESPACE = "zelavis.service-principals";
const permission = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9.\-:/]{0,127}$/));
const recordSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1), accountId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  permissions: Schema.Array(permission).check(Schema.isMinLength(1), Schema.isMaxLength(30)),
  sealed: Schema.Struct({ algorithm: Schema.Literal("AES-256-GCM"), ciphertext: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{63}$/)),
    iv: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{16}$/)), tag: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/)) }),
  approvedBy: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)), approvedAt: Schema.String,
});

export class ServicePrincipalError extends Error {
  constructor(readonly status: number, readonly code: string, readonly permissions?: readonly string[]) { super(code); }
}

/** One runtime writer serializes approval, sealing, registry mutation and activation. */
export function createServicePrincipals(store: ZelavisSystemStore, masterSecret: string, auth: AuthApi | undefined, projectRole: boolean) {
  const permit = Semaphore.makeUnsafe(1);
  const key = (name: string) => `${masterSecret}\u0000service-principal:${name}`;
  const read = Effect.fn(function* (name: string) {
    const record = yield* integration(() => store.get(NAMESPACE, name));
    if (!record) return undefined;
    return yield* evaluate(() => {
      const parsed = Schema.decodeUnknownSync(recordSchema)(record.value);
      if (new Set(parsed.permissions).size !== parsed.permissions.length || !Number.isFinite(Date.parse(parsed.approvedAt))) throw new TypeError("Invalid service principal record.");
      return parsed;
    });
  });
  const view = Effect.fn(function* (service: Pick<ZelavisServiceRegistryEntry["service"], "name" | "marketplace" | "principal">) {
    if (!service.principal) return undefined;
    const record = yield* read(service.name);
    return { permissions: [...service.principal.permissions], approved: Boolean(record && service.principal.permissions.every(p => record.permissions.includes(p))),
      ...(record ? { accountId: record.accountId } : {}) };
  });
  const approve = Effect.fn(function* (service: Pick<ZelavisServiceRegistryEntry["service"], "name" | "marketplace" | "principal">, approval: unknown, principal: ZelavisPrincipal | undefined, updating = false) {
    const requested = service.principal?.permissions;
    if (!requested) {
      yield* retire(service.name, principal);
      return;
    }
    if (projectRole) return yield* evaluate(() => { throw new ServicePrincipalError(409, "principal_unsupported"); });
    const previous = yield* read(service.name);
    const unchanged = updating && previous && requested.every(p => previous.permissions.includes(p));
    if (unchanged && previous.permissions.length === requested.length) return;
    if (!unchanged && (!Array.isArray(approval) || approval.length !== requested.length || new Set(approval).size !== requested.length || !requested.every(p => approval.includes(p)))) {
      return yield* evaluate(() => { throw new ServicePrincipalError(409, "principal_approval_required", requested); });
    }
    if (!auth) return yield* evaluate(() => { throw new ServicePrincipalError(503, "principal_auth_unavailable"); });
    const result = yield* auth.runtime.mutation(NO_REQUEST, tx => grantServicePrincipal(tx, {
      principal, serviceName: service.name, title: service.marketplace?.title ?? service.name, permissions: requested,
    }));
    if (!result.ok) return yield* evaluate(() => { throw new ServicePrincipalError(403, result.code); });
    yield* Effect.gen(function* () {
      const sealed: EncryptedSecret = yield* evaluate(() => encryptSecret(result.token, key(service.name)));
      yield* integration(() => store.set(NAMESPACE, service.name, { schemaVersion: 1, accountId: result.accountId, permissions: [...requested],
        sealed: { ...sealed }, approvedBy: result.approvedBy, approvedAt: result.approvedAt }));
    }).pipe(Effect.onError(() => retire(service.name, principal).pipe(Effect.orDie)));
    return true;
  });
  const retire = Effect.fn(function* (name: string, principal?: ZelavisPrincipal) {
    if (auth) yield* auth.runtime.mutation(NO_REQUEST, tx => retireServicePrincipal(tx, name, principal?.id));
    yield* integration(() => store.delete(NAMESPACE, name));
  });
  const token = Effect.fn(function* (name: string) {
    const record = yield* read(name);
    return record ? yield* evaluate(() => decryptSecret(record.sealed, key(name))) : undefined;
  });
  return { view, approve, retire, token, read, exclusive: permit.withPermit };
}

export type ServicePrincipals = ReturnType<typeof createServicePrincipals>;
