import assert from "node:assert/strict";
import test from "node:test";

import {
  IdentityConflictError,
  createDatabaseAuthRepositories,
  createIdentity,
  createInMemoryAuthRepositories,
} from "../dist/app/identity/index.js";
import { createPlatformAuthRepositories } from "../dist/platform/auth-repositories.js";
import { createMemorySystemStore } from "../dist/index.js";
import { ORPHAN_CLAIM_GRACE_MS } from "../dist/app/identity/storage/unique-claims.js";
import { openTemporaryDatabase } from "./_database.mjs";

// The same guarantees, against every place identity data can live.
const BACKENDS = [
  ["memory", async () => ({ repositories: createInMemoryAuthRepositories() })],
  ["platform System Store", async () => {
    const store = createMemorySystemStore();
    return { repositories: createPlatformAuthRepositories(store), store };
  }],
  ["Project database", async (t) => {
    const { api } = await openTemporaryDatabase(t);
    return { repositories: createDatabaseAuthRepositories(api, { tenantId: "tenant_auth" }) };
  }],
];

const expiresAt = () => new Date(Date.now() + 60_000);
const settle = (promises) => Promise.allSettled(promises);
const won = (results) => results.filter((result) => result.status === "fulfilled");
const conflicts = (results) =>
  results.filter((result) => result.status === "rejected" && result.reason instanceof IdentityConflictError);

for (const [name, make] of BACKENDS) {
  test(`${name}: racing registrations of one email produce exactly one account`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });

    const results = await settle(
      Array.from({ length: 12 }, (_, index) =>
        auth.accounts.create({ id: `account_${index}`, email: "Same@Example.com" }),
      ),
    );

    assert.equal(won(results).length, 1);
    assert.equal(conflicts(results).length, 11, "every loser reports a conflict, not a generic error");
    assert.equal((await auth.accounts.list()).length, 1);
    assert.ok(await auth.accounts.findByEmail("same@example.com"));
  });

  test(`${name}: racing registrations of one username produce exactly one account`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });

    const results = await settle(
      Array.from({ length: 8 }, (_, index) =>
        auth.accounts.create({ id: `account_${index}`, username: "ivan" }),
      ),
    );

    assert.equal(won(results).length, 1);
    assert.equal((await auth.accounts.list()).length, 1);
  });

  test(`${name}: racing credentials for one provider identifier produce exactly one`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });
    await auth.accounts.create({ id: "account_1", username: "one" });

    const results = await settle(
      Array.from({ length: 8 }, (_, index) =>
        auth.credentials.create({
          id: `credential_${index}`,
          accountId: "account_1",
          provider: "oidc",
          identifier: "subject-1",
        }),
      ),
    );

    assert.equal(won(results).length, 1);
    assert.equal((await auth.credentials.listByAccountId("account_1")).length, 1);
  });

  test(`${name}: a failed write does not leave the value claimed, and delete frees it`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });

    await auth.accounts.create({ id: "account_1", email: "a@example.com", username: "a" });
    // Loses on the second key: the first must not stay claimed by the loser.
    await assert.rejects(
      auth.accounts.create({ id: "account_2", email: "b@example.com", username: "a" }),
      IdentityConflictError,
    );
    await auth.accounts.create({ id: "account_3", email: "b@example.com", username: "c" });

    await auth.accounts.delete("account_1");
    await auth.accounts.create({ id: "account_4", email: "a@example.com", username: "a" });
    assert.deepEqual(
      (await auth.accounts.list()).map((account) => account.id).sort(),
      ["account_3", "account_4"],
    );
  });

  test(`${name}: moving an account to a taken email is refused, to a free one frees the old`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });
    const first = await auth.accounts.create({ id: "account_1", email: "a@example.com" });
    await auth.accounts.create({ id: "account_2", email: "b@example.com" });

    await assert.rejects(
      repositories.accounts.update({ ...first, email: "b@example.com" }),
      IdentityConflictError,
    );
    await repositories.accounts.update({ ...first, email: "c@example.com" });
    await auth.accounts.create({ id: "account_3", email: "a@example.com" });
  });

  test(`${name}: two racing rotations of one session yield exactly one new session`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });
    await auth.accounts.create({ id: "account_1", username: "one" });

    for (let round = 0; round < 10; round += 1) {
      const issued = await auth.sessions.create({ accountId: "account_1", expiresAt: expiresAt() });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => auth.sessions.rotate(issued.session.id)),
      );
      const winners = results.filter(Boolean);

      assert.equal(winners.length, 1, `round ${round}`);
      assert.equal(await auth.sessions.resolveToken(issued.token), null, "the old token is dead");
      assert.ok(await auth.sessions.resolveToken(winners[0].token), "the new token works");
    }
  });

  test(`${name}: nothing issued before a revoke-all survives it, however they interleave`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });
    await auth.accounts.create({ id: "account_1", username: "one" });

    for (let round = 0; round < 25; round += 1) {
      const issued = await auth.sessions.create({ accountId: "account_1", expiresAt: expiresAt() });
      const [rotated] = await Promise.all([
        auth.sessions.rotate(issued.session.id),
        // Started slightly later or earlier by the scheduler, never coordinated.
        auth.sessions.revokeAll("account_1"),
      ]);

      // Once revoke-all has returned, no earlier session is usable: not the
      // original, and not the one the racing rotation produced.
      assert.equal(await auth.sessions.resolveToken(issued.token), null, `round ${round}: original`);
      if (rotated) {
        assert.equal(await auth.sessions.resolveToken(rotated.token), null, `round ${round}: rotated`);
      }
    }
  });

  test(`${name}: revoke-all keeps only the session the caller names`, async (t) => {
    const { repositories } = await make(t);
    const auth = await createIdentity({ repositories });
    await auth.accounts.create({ id: "account_1", username: "one" });
    const keep = await auth.sessions.create({ accountId: "account_1", expiresAt: expiresAt() });
    const other = await auth.sessions.create({ accountId: "account_1", expiresAt: expiresAt() });

    const revoked = await auth.sessions.revokeAll("account_1", { exceptSessionId: keep.session.id });

    assert.deepEqual(revoked.map((session) => session.id), [other.session.id]);
    assert.ok(await auth.sessions.resolveToken(keep.token));
    assert.equal(await auth.sessions.resolveToken(other.token), null);
    // A session issued afterwards belongs to the new epoch and works.
    const later = await auth.sessions.create({ accountId: "account_1", expiresAt: expiresAt() });
    assert.ok(await auth.sessions.resolveToken(later.token));
  });
}

test("a claim left by a crashed creator is recovered after the grace period, not before", async () => {
  const store = createMemorySystemStore();
  const repositories = createPlatformAuthRepositories(store);
  const auth = await createIdentity({ repositories });
  const NAMESPACE = "zelavis.platform.auth";

  // A creator claimed the email, then died before writing its account.
  await store.set(NAMESPACE, "unique:account:email:ghost@example.com", {
    owner: "account_ghost",
    at: Date.now(),
  });
  await assert.rejects(
    auth.accounts.create({ id: "account_1", email: "ghost@example.com" }),
    IdentityConflictError,
    "a fresh claim may belong to a creator that is between its two writes",
  );

  await store.set(NAMESPACE, "unique:account:email:ghost@example.com", {
    owner: "account_ghost",
    at: Date.now() - ORPHAN_CLAIM_GRACE_MS - 1,
  });
  const created = await auth.accounts.create({ id: "account_1", email: "ghost@example.com" });
  assert.equal(created.id, "account_1");
});
