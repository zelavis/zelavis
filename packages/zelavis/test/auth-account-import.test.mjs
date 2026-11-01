// Importing accounts from another system: profiles carry over, PBKDF2-SHA256 passwords (Zelavis's or Django's
// format) carry over and sign in, bcrypt, scrypt and Firebase hashes sign in and are replaced by Zelavis's own at
// that first sign-in, other hashes leave the account to recover its password, a dry run writes nothing, and a
// repeated import skips what exists.
import assert from "node:assert/strict";
import { pbkdf2Sync, scryptSync } from "node:crypto";
import test from "node:test";
import { createMemorySystemStore, zelavis } from "../dist/index.js";
import { PASSWORD_PROVIDER } from "../dist/app/identity/index.js";
import { portablePasswordHash } from "../dist/app/identity/account-import.js";

const TOKEN = "account-import-bootstrap-token-32-chars";
const djangoHash = (password, salt, iterations = 120_000) =>
  `pbkdf2_sha256$${iterations}$${salt}$${pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64")}`;

async function owner() {
  const systemStore = createMemorySystemStore();
  const runtime = await zelavis({ systemStore, bootstrap: { token: TOKEN } });
  await runtime.plain({ url: "/zelavis/api/v1/auth/bootstrap", method: "POST", headers: { origin: "http://localhost" },
    body: { bootstrapToken: TOKEN, provider: PASSWORD_PROVIDER, account: { displayName: "Owner" }, credential: { identifier: "owner@example.com", password: "correct horse battery staple" } } });
  const login = await runtime.plain({ url: `/zelavis/api/v1/auth/authenticate/${PASSWORD_PROVIDER}`, method: "POST", body: { identifier: "owner@example.com", password: "correct horse battery staple" } });
  const headers = { authorization: `Bearer ${login.body.session.token}` };
  return { runtime, systemStore, call: (body) => runtime.plain({ url: "/zelavis/api/v1/auth/accounts/import", method: "POST", headers, body }) };
}
// Generated with `htpasswd -bnBC 5 "" short` (Apache's bcrypt): a password shorter than the policy still carries.
const BCRYPT_SHORT = "$2y$05$guQQF.7Y1briSwnHQRZ4Ou5JPGuMKhbQRR9PjATYyaTkdpfnXdrzq";
// Firebase's published example (github.com/firebase/scrypt): password "user1password".
const FIREBASE = {
  hashConfig: { algorithm: "firebase-scrypt", signerKey: "jxspr8Ki0RYycVU8zykbdLGjFQ3McFUH0uiiTvC8pVMXAn210wjLNmdZJzxUECKbm0QsEmYUSDzZvpjeJ9WmXA==", saltSeparator: "Bw==", rounds: 8, memCost: 14 },
  passwordHash: "lSrfV15cpx95/sZS2W9c9Kp6i/LVgQNDNC/qzrCnh1SAyZvqmZqAjTdn3aoItz+VHjoZilo78198JAdRuid5lQ==",
  passwordSalt: "42xEC+ixf3L2lw==",
};
const djangoScrypt = (password, salt) => `scrypt$16384$${salt}$8$1$${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("base64")}`;
const storedHashOf = async (store, identifier) => {
  for (const { namespace } of await store.namespaces()) {
    for (let after; ;) {
      const page = await store.page(namespace, { limit: 200, ...(after === undefined ? {} : { after }) });
      for (const record of page.records) {
        const value = record.value;
        if (value && typeof value === "object" && value.identifier === identifier && "secretHash" in value) return value.secretHash;
      }
      if (page.next === undefined || page.records.length === 0) break;
      after = page.next;
    }
  }
  return undefined;
};
const signIn = (runtime, identifier, password) => runtime.plain({ url: `/zelavis/api/v1/auth/authenticate/${PASSWORD_PROVIDER}`, method: "POST", body: { identifier, password } });

test("accounts import with their profiles; verifiable password hashes sign in, others need a reset", async () => {
  const { runtime, call } = await owner();
  const accounts = [
    { email: "Ada@Example.com", displayName: "Ada", verified: true, metadata: { plan: "pro" }, passwordHash: djangoHash("ada's long passphrase!", "s4lty") },
    { username: "grace", displayName: "Grace", passwordHash: "md5$1a2b$0123456789abcdef0123456789abcdef" },
    { email: "linus@example.com" },
  ];
  const plan = await call({ accounts, dryRun: true });
  assert.equal(plan.status, 200);
  assert.deepEqual([plan.body.created, plan.body.needsReset, plan.body.problems], [0, ["grace", "linus@example.com"], []]);
  assert.equal((await signIn(runtime, "ada@example.com", "ada's long passphrase!")).status !== 200, true, "a dry run writes nothing");

  const done = await call({ accounts });
  assert.deepEqual([done.body.created, done.body.skipped, done.body.needsReset], [3, [], ["grace", "linus@example.com"]]);
  assert.equal((await signIn(runtime, "ADA@example.com", "ada's long passphrase!")).status, 200, "a Django PBKDF2 hash signs in after import");
  assert.notEqual((await signIn(runtime, "grace", "anything at all here")).status, 200, "an unverifiable hash is never trusted");

  const again = await call({ accounts });
  assert.deepEqual([again.body.created, again.body.skipped.map((entry) => entry.identifier)], [0, ["ada@example.com", "grace", "linus@example.com"]]);

  const bad = await call({ accounts: [{ email: "not an email" }, { displayName: "nobody" }, { email: "x@y.z" }, { email: "X@Y.z" }] });
  assert.deepEqual(bad.body.problems.map((entry) => entry.row), [1, 2, 4]);
  assert.equal(bad.body.created, 0, "with any problem nothing is written");
});

test("bcrypt, scrypt and Firebase hashes sign in once and are then replaced by Zelavis's own", async () => {
  const { runtime, systemStore, call } = await owner();
  const accounts = [
    { username: "brook", passwordHash: BCRYPT_SHORT },
    { email: "sam@example.com", passwordHash: djangoScrypt("sam's scrypt passphrase", "pepper") },
    { email: "fire@example.com", passwordHash: FIREBASE.passwordHash, passwordSalt: FIREBASE.passwordSalt },
    { email: "nosalt@example.com", passwordHash: FIREBASE.passwordHash },
  ];
  const done = await call({ accounts, hashConfig: FIREBASE.hashConfig });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.deepEqual([done.body.created, done.body.rehashOnSignIn, done.body.needsReset], [4, ["brook", "sam@example.com", "fire@example.com"], ["nosalt@example.com"]]);
  assert.match(await storedHashOf(systemStore, "brook"), /^\$2y\$05\$/, "kept as it came until its owner signs in");

  assert.notEqual((await signIn(runtime, "brook", "shorts")).status, 200, "a wrong password does not match");
  for (const [identifier, password] of [["brook", "short"], ["sam@example.com", "sam's scrypt passphrase"], ["fire@example.com", "user1password"]]) {
    assert.equal((await signIn(runtime, identifier, password)).status, 200, `${identifier} signs in with the password it had`);
    assert.match(await storedHashOf(systemStore, identifier), /^pbkdf2-sha256\$/, `${identifier}'s hash is replaced at that sign-in`);
    assert.equal((await signIn(runtime, identifier, password)).status, 200, `${identifier} signs in against the new hash`);
  }
  const refused = await call({ accounts: [{ email: "a@b.c" }], hashConfig: { algorithm: "argon2" } });
  assert.equal(refused.status >= 400, true, "an unknown hashConfig is refused, never ignored");
});

test("only hashes that can be verified here are carried over", () => {
  assert.match(portablePasswordHash(djangoHash("x", "salt")), /^pbkdf2-sha256\$120000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]{43}$/);
  assert.equal(portablePasswordHash(djangoHash("x", "salt", 10_000)), undefined, "too few iterations");
  assert.equal(portablePasswordHash("$2b$10$abcdefghijklmnopqrstuuSomethingElse"), undefined, "a malformed bcrypt hash");
  assert.equal(portablePasswordHash(BCRYPT_SHORT), BCRYPT_SHORT);
  assert.equal(portablePasswordHash(BCRYPT_SHORT.replace("$05$", "$15$")), undefined, "a bcrypt cost above 14 is too slow to verify at sign-in");
  assert.match(portablePasswordHash(`bcrypt_sha256$${BCRYPT_SHORT}`), /^bcrypt-sha256\$\$2y\$/);
  assert.match(portablePasswordHash(djangoScrypt("x", "salt")), /^scrypt\$14\$8\$1\$c2FsdA\$/);
  assert.equal(portablePasswordHash("scrypt$1048576$salt$8$1$aGFzaGhhc2hoYXNoaGFzaA=="), undefined, "scrypt above 64 MiB");
  assert.equal(portablePasswordHash(FIREBASE.passwordHash, { salt: FIREBASE.passwordSalt }), undefined, "Firebase needs its hashConfig");
  const own = "pbkdf2-sha256$600000$yLraSn-7jde16kwYd-a7HQ$PjucgodjtQ-_xh7HLdhK_1NkRdh708YnHfRZ3wl52ag";
  assert.equal(portablePasswordHash(own), own);
});

test("importing accounts answers the same through the route, the SDK and the CLI", async () => {
  const { createZelavisClient } = await import("../dist/sdk/fetch.js");
  const { runAuthCommand } = await import("../dist/cli/auth.js");
  const { call, runtime } = await owner();
  const body = { accounts: [{ email: "one@example.com" }, { username: "two" }], dryRun: true };
  const http = (await call(body)).body;
  const login = await signIn(runtime, "owner@example.com", "correct horse battery staple");
  const fetch = (input, init) => runtime.fetch(new Request(String(input), init));
  const client = createZelavisClient({ baseUrl: "http://localhost", rootPath: "/zelavis", fetch, headers: { authorization: `Bearer ${login.body.session.token}` } });
  const sdk = await client.auth.admin.importAccounts(body);
  const originalFetch = globalThis.fetch, originalLog = console.log, lines = [];
  globalThis.fetch = fetch; console.log = (line) => lines.push(String(line));
  try { await runAuthCommand(["import-accounts", "--data", JSON.stringify(body), "--url", "http://localhost/zelavis", "--token", login.body.session.token, "--json"]); }
  finally { globalThis.fetch = originalFetch; console.log = originalLog; }
  assert.deepEqual(sdk, http);
  assert.deepEqual(JSON.parse(lines.join("\n")), http);
});
