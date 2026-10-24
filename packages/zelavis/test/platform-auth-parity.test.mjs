// Authentication's operations through the HTTP route, the SDK and the CLI, each against a Platform of its own: the same scenario
// has to answer the same, refusals included. Sign-in and the owner bootstrap are checked by what they refuse, since a bare
// Platform has no credential to sign in with.
import assert from "node:assert/strict";
import test from "node:test";
import { runAuthCommand } from "../dist/cli/auth.js";
import { outcome, platform } from "./_runtime.mjs";

const normalized = (value) => JSON.parse(JSON.stringify(value).replace(/security_event_[0-9a-f-]+/g, "security_event_ID").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, "UUID"));

test("authentication answers the same through HTTP, the SDK and the CLI, refusals included", async (t) => {
  const account = { id: "ann", email: "ann@example.com", displayName: "Ann", type: "user" };
  const credentials = { accountId: "ann", provider: "password", identifier: "ann@example.com" };
  const results = {};
  for (const surface of ["http", "sdk", "cli"]) {
    const p = await platform(t);
    const json = (value) => JSON.stringify(value);
    const steps = {
      http: [
        () => p.send("GET", "/auth/providers"), () => p.send("GET", "/auth/oauth/providers"), () => p.send("GET", "/auth/recovery/providers"),
        () => p.send("GET", "/auth/bootstrap"), () => p.send("POST", "/auth/bootstrap", { bootstrapToken: "wrong" }),
        () => p.send("GET", "/auth/accounts"), () => p.send("POST", "/auth/accounts", account), () => p.send("GET", "/auth/accounts"),
        () => p.send("POST", "/auth/credentials", credentials),
        () => p.send("GET", "/auth/accounts/ann/sessions"), () => p.send("DELETE", "/auth/accounts/ann/sessions"), () => p.send("DELETE", "/auth/accounts/ann/sessions/nope"),
        () => p.send("GET", "/auth/session"), () => p.send("GET", "/auth/sessions"), () => p.send("DELETE", "/auth/sessions/nope"),
        () => p.send("POST", "/auth/authenticate/password", { identifier: "ann@example.com", password: "wrong" }),
        () => p.send("POST", "/auth/recovery/password", { identifier: "ann@example.com" }), () => p.send("POST", "/auth/recovery/password/complete", {}),
        () => p.send("POST", "/auth/oauth/nope/start"), () => p.send("POST", "/auth/oauth/nope/link/start"),
        () => p.send("GET", "/auth/oauth/connections"), () => p.send("DELETE", "/auth/oauth/connections/nope"),
        () => p.send("GET", "/auth/security/events").then((answer) => ({ count: answer.events.length })),
      ],
      sdk: [
        () => p.client.auth.providers(), () => p.client.auth.oauthProviders(), () => p.client.auth.recoveryProviders(),
        () => p.client.auth.bootstrapStatus(), () => p.client.auth.bootstrap({ bootstrapToken: "wrong" }),
        () => p.client.auth.admin.accounts(), () => p.client.auth.admin.createAccount(account), () => p.client.auth.admin.accounts(),
        () => p.client.auth.admin.createCredentials(credentials),
        () => p.client.auth.admin.accountSessions("ann"), () => p.client.auth.admin.revokeAccountSessions("ann"), () => p.client.auth.admin.revokeAccountSession("ann", "nope"),
        () => p.client.auth.getSession(), () => p.client.auth.sessions(), () => p.client.auth.revokeSession("nope"),
        () => p.client.auth.signInWithPassword({ identifier: "ann@example.com", password: "wrong" }),
        () => p.client.auth.beginRecovery("password", { identifier: "ann@example.com" }), () => p.client.auth.completeRecovery("password", {}),
        () => p.client.auth.signInWithOAuth("nope"), () => p.client.auth.linkIdentity("nope"),
        () => p.client.auth.admin.oauthConnections(), () => p.client.auth.admin.removeOAuth("nope"),
        () => p.client.auth.admin.securityEvents().then((answer) => ({ count: answer.events.length })),
      ],
      cli: [
        () => p.cli(runAuthCommand, ["providers"]), () => p.cli(runAuthCommand, ["oauth-providers"]), () => p.cli(runAuthCommand, ["recovery-providers"]),
        () => p.cli(runAuthCommand, ["bootstrap-status"]), () => p.cli(runAuthCommand, ["bootstrap", "--data", json({ bootstrapToken: "wrong" })]),
        () => p.cli(runAuthCommand, ["accounts"]), () => p.cli(runAuthCommand, ["create-account", "--data", json(account)]), () => p.cli(runAuthCommand, ["accounts"]),
        () => p.cli(runAuthCommand, ["create-credentials", "--data", json(credentials)]),
        () => p.cli(runAuthCommand, ["account-sessions", "ann"]), () => p.cli(runAuthCommand, ["revoke-account-sessions", "ann"]), () => p.cli(runAuthCommand, ["revoke-account-session", "ann", "nope"]),
        () => p.cli(runAuthCommand, ["session"]), () => p.cli(runAuthCommand, ["sessions"]), () => p.cli(runAuthCommand, ["revoke-session", "nope"]),
        () => p.cli(runAuthCommand, ["sign-in", "password", "--data", json({ identifier: "ann@example.com", password: "wrong" })]),
        () => p.cli(runAuthCommand, ["recover", "password", "--data", json({ identifier: "ann@example.com" })]), () => p.cli(runAuthCommand, ["complete-recovery", "password", "--data", "{}"]),
        () => p.cli(runAuthCommand, ["oauth-start", "nope"]), () => p.cli(runAuthCommand, ["link-start", "nope"]),
        () => p.cli(runAuthCommand, ["oauth-connections"]), () => p.cli(runAuthCommand, ["remove-oauth", "nope"]),
        () => p.cli(runAuthCommand, ["security-events"]).then((answer) => ({ count: answer.events.length })),
      ],
    };
    results[surface] = [];
    for (const step of steps[surface]) results[surface].push(await outcome(step));
  }
  // The void operations answer `{ revoked | recovered | removed: true }` in the CLI and nothing from the route and the SDK: compare them by success.
  // The SDK's `oauthConnections()` has always handed over the providers themselves, where the route wraps them.
  const unwrap = (entry) => entry.answer && typeof entry.answer === "object" && !Array.isArray(entry.answer) && Object.keys(entry.answer).join() === "providers" ? { answer: entry.answer.providers } : entry;
  const brief = (list) => normalized(list.map(unwrap).map((entry) => entry.answer !== undefined && entry.answer !== null && typeof entry.answer === "object" && ["revoked", "recovered", "removed", "signedOut"].some((key) => key in entry.answer && entry.answer[key] === true) ? { answer: "done" } : entry.answer === null ? { answer: "done" } : entry));
  const accepted = results.http.filter((entry) => entry.answer !== undefined).length;
  assert.ok(accepted >= 10, `much of the scenario is accepted (${accepted})`);
  assert.deepEqual(results.http[6].answer.id, "ann", "an account is created");
  assert.equal(results.http[7].answer.length, 1, "and listed");
  assert.deepEqual(brief(results.sdk), brief(results.http));
  assert.deepEqual(brief(results.cli), brief(results.http));
});
