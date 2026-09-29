/**
 * How long a claim is honoured with no entity behind it. A creator writes its
 * entity within milliseconds of claiming, so a claim this old has no live
 * creator; without the wait, a second creator could mistake a first that is
 * merely between its two writes for a crashed one and take its claim.
 */
export const ORPHAN_CLAIM_GRACE_MS = 60_000;

/**
 * Uniqueness that holds under concurrency.
 *
 * "Find it, and if nothing is there create it" lets two racing callers both see
 * nothing and both create. What a store *can* do atomically is create a record
 * that must not already exist, so uniqueness is a claim on a key: one record
 * per unique value, created if-absent, naming its owner. A repository claims the
 * keys first and writes the entity second.
 *
 * A crash between the two leaves a claim whose owner never existed. It would
 * block that value forever, so a claim whose owner is missing is taken over
 * rather than honoured.
 */
import { IdentityConflictError } from "../core/errors.js";
import type {
  AccountRepository,
  CredentialRepository,
} from "../contracts/repositories.js";
import type { Account, Credential } from "../domain/entities.js";

export interface ClaimBackend {
  /**
   * Atomic create-if-absent. Reports the current owner, and when it claimed the
   * key, if it already exists.
   */
  claim(
    key: string,
    owner: string,
  ): Promise<{ claimed: true } | { claimed: false; owner: string; at: number }>;
  /** Atomically move a claim from a stale owner to a new one. */
  takeover(key: string, staleOwner: string, owner: string): Promise<boolean>;
  /** Removes the claim only while `owner` still holds it. */
  release(key: string, owner: string): Promise<void>;
}

export interface UniqueKey {
  key: string;
  field: string;
  message: string;
}

export function accountKeys(account: Pick<Account, "email" | "username">): UniqueKey[] {
  return [
    ...(account.email
      ? [{ key: `account:email:${account.email}`, field: "email", message: "An account already uses that email." }]
      : []),
    ...(account.username
      ? [{ key: `account:username:${account.username}`, field: "username", message: "An account already uses that username." }]
      : []),
  ];
}

export function credentialKeys(credential: Pick<Credential, "provider" | "identifier">): UniqueKey[] {
  return [{
    key: `credential:${credential.provider}\u0000${credential.identifier}`,
    field: "identifier",
    message: "That provider identifier is already registered.",
  }];
}

export async function claimAll(
  backend: ClaimBackend,
  keys: readonly UniqueKey[],
  owner: string,
  ownerExists: (owner: string) => Promise<boolean>,
): Promise<void> {
  const claimed: UniqueKey[] = [];
  try {
    for (const unique of keys) {
      const result = await backend.claim(unique.key, owner);
      if (result.claimed) {
        claimed.push(unique);
        continue;
      }
      if (result.owner === owner) {
        // Already ours: a retry of the same write.
        claimed.push(unique);
        continue;
      }
      if (
        Date.now() - result.at > ORPHAN_CLAIM_GRACE_MS &&
        !(await ownerExists(result.owner)) &&
        (await backend.takeover(unique.key, result.owner, owner))
      ) {
        claimed.push(unique);
        continue;
      }
      throw new IdentityConflictError(unique.field, unique.message);
    }
  } catch (error) {
    await Promise.all(claimed.map((unique) => backend.release(unique.key, owner)));
    throw error;
  }
}

export async function releaseAll(
  backend: ClaimBackend,
  keys: readonly UniqueKey[],
  owner: string,
): Promise<void> {
  await Promise.all(keys.map((unique) => backend.release(unique.key, owner)));
}

function difference(from: readonly UniqueKey[], without: readonly UniqueKey[]): UniqueKey[] {
  const drop = new Set(without.map((unique) => unique.key));
  return from.filter((unique) => !drop.has(unique.key));
}

/** Adds atomic email/username uniqueness to any account repository. */
export function withUniqueAccounts(
  inner: AccountRepository,
  backend: ClaimBackend,
): AccountRepository {
  const exists = async (id: string) => (await inner.findById(id)) !== null;
  return {
    // Delegated one by one: a repository may be a class instance, whose
    // methods a spread would silently drop.
    findById: (id) => inner.findById(id),
    findByEmail: (email) => inner.findByEmail(email),
    findByUsername: (username) => inner.findByUsername(username),
    list: () => inner.list(),
    async create(account) {
      const keys = accountKeys(account);
      await claimAll(backend, keys, account.id, exists);
      try {
        return await inner.create(account);
      } catch (error) {
        await releaseAll(backend, keys, account.id);
        throw error;
      }
    },
    async update(account) {
      const before = await inner.findById(account.id);
      const oldKeys = before ? accountKeys(before) : [];
      const newKeys = accountKeys(account);
      const added = difference(newKeys, oldKeys);
      await claimAll(backend, added, account.id, exists);
      try {
        const written = await inner.update(account);
        await releaseAll(backend, difference(oldKeys, newKeys), account.id);
        return written;
      } catch (error) {
        await releaseAll(backend, added, account.id);
        throw error;
      }
    },
    async mutate(id, mutation) {
      return inner.mutate(id, (current) => {
        const next = mutation(current);
        if (
          current && next &&
          (next.email !== current.email || next.username !== current.username)
        ) {
          throw new IdentityConflictError(
            "identity",
            "Email and username change only through update, which keeps them unique.",
          );
        }
        return next;
      });
    },
    async delete(id) {
      const before = await inner.findById(id);
      const deleted = await inner.delete(id);
      if (before) await releaseAll(backend, accountKeys(before), id);
      return deleted;
    },
  };
}

/** Adds atomic `(provider, identifier)` uniqueness to any credential repository. */
export function withUniqueCredentials(
  inner: CredentialRepository,
  backend: ClaimBackend,
): CredentialRepository {
  const exists = async (id: string) => (await inner.findById(id)) !== null;
  return {
    findById: (id) => inner.findById(id),
    findByProviderIdentifier: (provider, identifier) =>
      inner.findByProviderIdentifier(provider, identifier),
    listByAccountId: (accountId) => inner.listByAccountId(accountId),
    async create(credential) {
      const keys = credentialKeys(credential);
      await claimAll(backend, keys, credential.id, exists);
      try {
        return await inner.create(credential);
      } catch (error) {
        await releaseAll(backend, keys, credential.id);
        throw error;
      }
    },
    async update(credential) {
      const before = await inner.findById(credential.id);
      const oldKeys = before ? credentialKeys(before) : [];
      const newKeys = credentialKeys(credential);
      const added = difference(newKeys, oldKeys);
      await claimAll(backend, added, credential.id, exists);
      try {
        const written = await inner.update(credential);
        await releaseAll(backend, difference(oldKeys, newKeys), credential.id);
        return written;
      } catch (error) {
        await releaseAll(backend, added, credential.id);
        throw error;
      }
    },
    async delete(id) {
      const before = await inner.findById(id);
      const deleted = await inner.delete(id);
      if (before) await releaseAll(backend, credentialKeys(before), id);
      return deleted;
    },
  };
}
