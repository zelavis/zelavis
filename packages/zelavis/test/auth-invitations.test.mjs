import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nodeAdapter } from "../dist/adapters/node.js";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { runCli } from "../dist/cli/commands.js";
import { Zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { parseMessage, startSmtpServer, testCertificate } from "./_smtp-server.mjs";
import { accountsTables } from "../dist/auth/accounts/tables.js";
import { emailTables } from "../dist/auth/email/tables.js";
import { expiredInvitationsSweep } from "../dist/auth/invitations/sweep.js";
import { invitationsTables } from "../dist/auth/invitations/tables.js";
import { NO_REQUEST } from "../dist/auth/runtime/index.js";
import { composeAuth, expectStatus, recordingOutbox, waitFor } from "./_auth.mjs";

const PASSWORD = "invited accounts use a long password";
const BOOTSTRAP = "invitation-qualification-bootstrap-secret";
const WEEK_MS = 7 * 24 * 60 * 60_000;
const grant = (permission, projectId = "first-app") => ({ permission, scope: { type: "project", projectId } });
const access = (grants = [grant("project.view")], role = "customer", permissions = []) => ({ role, permissions, grants, roleAssignments: [] });

async function platform(t) {
  const email = recordingOutbox();
  email.linkBaseUrl = new URL("https://example.test/control/zelavis");
  const app = await composeAuth(t, { registration: false, bootstrapped: false, bootstrapToken: BOOTSTRAP, emailOutbox: email });
  const owner = await expectStatus(await app.call("bootstrap", {
    method: "POST", body: { bootstrapToken: BOOTSTRAP, username: "owner", password: PASSWORD },
  }), 201);
  const send = (path, method = "GET", body, by = owner.tokens) => app.call(path, { method, body, headers: app.bearer(by) });
  const invite = (address, preset = access(), by = owner.tokens) => send("invitations", "POST", { email: address, access: preset }, by);
  const accept = (token, username, session) => app.call("invitations/accept", {
    method: "POST", body: { token, ...(username === undefined ? {} : { username, password: PASSWORD }) },
    ...(session ? { headers: app.bearer(session) } : {}),
  });
  const delivered = async (address, occurrence = 1) => {
    const messages = () => email.delivered.filter(message => message.to === address);
    await waitFor(() => messages().length >= occurrence, { what: "the invitation email" });
    const message = messages()[occurrence - 1];
    assert.equal(message.kind, "invitation");
    const link = new URL(message.text.match(/https:\/\/\S+/u)?.[0] ?? "");
    assert.equal(link.pathname, "/control/zelavis/invitation");
    assert.equal(link.search, "");
    assert.match(link.hash, /^#token=[A-Za-z0-9_-]{43}$/u);
    return new URLSearchParams(link.hash.slice(1)).get("token");
  };
  return { ...app, email, owner, send, invite, accept, delivered };
}

test("invitations admit exactly one account with verified email and preset access under concurrent acceptance", async (t) => {
  const a = await platform(t);
  const address = "NewUser@example.test";
  const invitation = await expectStatus(await a.invite(address), 201);
  const token = await a.delivered(address);
  assert.equal(invitation.status, "pending");
  assert.equal(Date.parse(invitation.expiresAt) - a.clock.now, WEEK_MS);
  assert.deepEqual(Object.keys(invitation).sort(), ["access", "createdAt", "email", "expiresAt", "id", "status"]);
  const [stored] = await a.rows(invitationsTables.invitations);
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal((await expectStatus(await a.call("registration"), 200)).enabled, false);

  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => a.accept(token, `user-${i}`)));
  const winners = results.filter(result => result.status === 200);
  assert.equal(winners.length, 1);
  for (const response of results.filter(result => result.status !== 200)) {
    assert.equal((await expectStatus(response, 400)).code, "invalid_invitation");
  }
  const { tokens, userId } = await winners[0].json();
  const session = await expectStatus(await a.send("session", "GET", undefined, tokens), 200);
  assert.deepEqual(session.account.roles, ["customer"]);
  assert.deepEqual(session.account.grants, access().grants);
  assert.equal((await a.rows(accountsTables.accounts)).length, 2);
  assert.deepEqual((await a.rows(emailTables.verifiedEmails)).map(({ userId, email, normalizedEmail, isPrimary }) =>
    ({ userId, email, normalizedEmail, isPrimary })), [{ userId, email: address, normalizedEmail: address.toLowerCase(), isPrimary: true }]);
  const page = await expectStatus(await a.send("invitations"), 200);
  assert.deepEqual(page.invitations, [{ ...invitation, status: "accepted", acceptedAccountId: userId }]);
  assert.equal((await a.rows(invitationsTables.counter))[0].pending, 0);
});

test("resending replaces the link and revocation, expiry and redemption use one refusal", async (t) => {
  const a = await platform(t);
  const address = "resend@example.test";
  const one = await expectStatus(await a.invite(address), 201);
  const original = await a.delivered(address);
  const resend = await expectStatus(await a.send(`invitations/${one.id}/resend`, "POST"), 202);
  const replacement = await a.delivered(address, 2);
  assert.deepEqual(resend, one);
  assert.notEqual(replacement, original);
  const invalid = await expectStatus(await a.accept(original, "recipient"), 400);
  assert.equal(invalid.code, "invalid_invitation");
  assert.equal((await expectStatus(await a.send(`invitations/${one.id}`, "DELETE"), 200)).status, "revoked");
  assert.deepEqual(await expectStatus(await a.accept(replacement, "recipient"), 400), invalid);

  const two = await expectStatus(await a.invite(address), 201);
  const expiring = await a.delivered(address, 3);
  a.clock.now = Date.parse(two.expiresAt);
  assert.deepEqual(await expectStatus(await a.accept(expiring, "recipient"), 400), invalid);
  assert.deepEqual(await expectStatus(await a.accept(expiring, "recipient", a.owner.tokens), 400), invalid);
  assert.equal(await a.run(expiredInvitationsSweep.run(a.auth.runtime)), 1);
  assert.equal((await a.rows(invitationsTables.counter))[0].pending, 0);
  assert.equal((await a.rows(invitationsTables.invitations)).find(row => row._id === two.id).status, "revoked");
});

test("only the invited account can accept for a verified address, and acceptance merges access", async (t) => {
  const a = await platform(t);
  const address = "merge@example.test";
  await expectStatus(await a.invite(address, access([grant("project.view", "previous-app")])), 201);
  const existing = await expectStatus(await a.accept(await a.delivered(address), "merging-user"), 200);
  await expectStatus(await a.invite("other@example.test"), 201);
  const other = await expectStatus(await a.accept(await a.delivered("other@example.test"), "another-user"), 200);
  await expectStatus(await a.invite(address.toUpperCase(), access([grant("project.view")], "operator")), 201);
  const token = await a.delivered(address.toUpperCase());
  for (const by of [undefined, other.tokens]) {
    const refusal = await expectStatus(await a.accept(token, "arbitrary", by), 409);
    assert.equal(refusal.code, "invitation_requires_sign_in");
    assert.ok(!JSON.stringify(refusal).includes(existing.userId));
  }
  const merged = await expectStatus(await a.accept(token, undefined, existing.tokens), 200);
  assert.equal(merged.userId, existing.userId);
  await expectStatus(await a.send("session", "GET", undefined, existing.tokens), 401);
  const { account } = await expectStatus(await a.send("session", "GET", undefined, merged.tokens), 200);
  assert.deepEqual(account.roles, ["operator"]);
  assert.deepEqual(account.grants, [grant("project.view", "previous-app"), grant("project.view")]);
  assert.equal(account.accessRevision, 1);
  assert.equal((await a.rows(accountsTables.accounts)).length, 3);
});

test("inviters can only delegate current access, including at acceptance", async (t) => {
  const a = await platform(t);
  const { account } = await expectStatus(await a.send("accounts", "POST", { username: "delegate", password: PASSWORD }), 201);
  const setAccess = (expectedRevision, grants) => a.send(`accounts/${account.id}/access`, "PUT", {
    ...access(grants, "customer", ["system.users.manage"]), expectedRevision,
  });
  await expectStatus(await setAccess(0, [grant("project.view")]), 200);
  const { tokens } = await expectStatus(await a.call("username-password/sign-in", {
    method: "POST", body: { username: "delegate", password: PASSWORD },
  }), 200);
  const refused = await expectStatus(await a.invite("scoped@example.test", access([grant("project.domains.manage")]), tokens), 403);
  assert.equal(refused.code, "account_access_forbidden");
  await expectStatus(await a.invite("scoped@example.test", access(), tokens), 201);
  const token = await a.delivered("scoped@example.test");
  await expectStatus(await setAccess(1, []), 200);
  assert.equal((await expectStatus(await a.accept(token, "recipient"), 400)).code, "invalid_invitation");
  assert.equal((await a.rows(invitationsTables.invitations))[0].status, "revoked");
});

test("mail availability, paging, the pending limit and the recomputing sweep", async (t) => {
  const a = await platform(t);
  const base = a.email.linkBaseUrl;
  a.email.linkBaseUrl = undefined;
  assert.equal((await expectStatus(await a.invite("disabled@example.test"), 409)).code, "email_unavailable");
  assert.deepEqual(await a.rows(invitationsTables.invitations), []);
  a.email.linkBaseUrl = base;
  const address = "pending@example.test";
  for (let index = 0; index < 500; index += 1) await expectStatus(await a.invite(address), 201);
  assert.equal((await expectStatus(await a.invite(address), 429)).code, "invitation_limit");
  const newest = await expectStatus(await a.send("invitations?limit=2"), 200);
  // Durably written accounts can share a clock time across Auth restarts.
  for (const row of newest.invitations) {
    await a.run(a.tenant.documents.update({
      collection: invitationsTables.invitations.collection, id: row.id, data: { _creationTime: a.clock.now + 1_000 },
    }));
  }
  const first = await expectStatus(await a.send("invitations?limit=1"), 200);
  const second = await expectStatus(await a.send(`invitations?limit=1&after=${first.next}`), 200);
  assert.deepEqual([first.invitations[0].id, second.invitations[0].id],
    newest.invitations.map(({ id }) => id).sort().reverse());
  await expectStatus(await a.send("invitations?after=invalid"), 400);
  await expectStatus(await a.send("invitations?limit=101"), 400);

  const [counter] = await a.rows(invitationsTables.counter);
  await a.run(a.auth.runtime.mutation(NO_REQUEST, tx => tx.db.patch(invitationsTables.counter, counter._id, { pending: 123 })));
  a.clock.now += WEEK_MS;
  for (const [changed, pending] of [[200, 300], [200, 100], [100, 0]]) {
    assert.equal(await a.run(expiredInvitationsSweep.run(a.auth.runtime)), changed);
    assert.equal((await a.rows(invitationsTables.counter))[0].pending, pending);
  }
});

test("an invitation cannot bypass required MFA enrollment", async (t) => {
  const a = await platform(t);
  await expectStatus(await a.send("mfa/policy", "PUT", { requiredFor: "all", expectedRevision: 0 }), 200);
  const address = "requires-mfa@example.test";
  await expectStatus(await a.invite(address), 201);
  const token = await a.delivered(address);
  const accepted = await expectStatus(await a.accept(token, "needs-mfa"), 200);
  assert.equal(accepted.status, "mfa_enrollment_required");
  assert.equal(accepted.tokens, undefined);
  assert.equal(typeof accepted.challenge, "string");
  await expectStatus(await a.call("mfa/totp", { method: "POST", body: { challenge: accepted.challenge } }), 200);
  assert.equal((await expectStatus(await a.accept(token, "needs-mfa"), 400)).code, "invalid_invitation");
});

test("Platform and App invitations use the same HTTP, SDK and CLI operations and exact Project Gateway authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-invitations-"));
  const { cert } = await testCertificate();
  const caFile = join(root, "smtp-ca.pem");
  await writeFile(caFile, cert);
  const previousCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = caFile;
  const defaults = getCACertificates("default");
  setDefaultCACertificates([...defaults, cert]);
  const platformServer = await startSmtpServer(t, { tls: "implicit" });
  const appServer = await startSmtpServer(t, { tls: "implicit" });
  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }),
    bootstrap: { token: BOOTSTRAP },
  });
  t.after(async () => {
    await zv.close();
    setDefaultCACertificates(defaults);
    if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousCa;
    await rm(root, { recursive: true, force: true });
  });
  const origin = "http://invitation-platform.test";
  const rootUrl = origin + "/zelavis";
  const through = (input, init) => zv.fetch(new Request(input, init));
  const client = (token) => createZelavisClient({ baseUrl: origin, fetch: through, headers: token && { authorization: `Bearer ${token}` } });
  const ownerToken = (await client().auth.bootstrap.claim({ bootstrapToken: BOOTSTRAP, username: "owner", password: PASSWORD })).tokens.accessToken;
  const owner = client(ownerToken);
  const app = await owner.projects.create({ id: "first-app", name: "First App", recipeName: "@zelavis/app" });
  await owner.projects.create({ id: "other-app", name: "Other App", recipeName: "@zelavis/app", start: false });

  const settings = (smtp, linkBaseUrl) => ({
    expectedRevision: 0, mode: "smtp", from: { address: "invites@example.test" },
    smtp: { host: smtp.host, port: smtp.port, security: "tls" }, linkBaseUrl,
  });
  await owner.email.setSettings(settings(platformServer, "https://dashboard.example.test/zelavis"));
  await owner.projects.setEmailSettings(app.id, settings(appServer, "https://app.example.test/zelavis"));

  const cli = async (args, token = ownerToken) => {
    const realFetch = globalThis.fetch, realLog = console.log, lines = [];
    globalThis.fetch = (input, init) => new URL(input instanceof Request ? input.url : input).origin === origin
      ? through(input, init) : realFetch(input, init);
    console.log = (...parts) => lines.push(parts.join(" "));
    try { await runCli([...args, "--url", rootUrl, "--token", token, "--json"]); }
    finally { globalThis.fetch = realFetch; console.log = realLog; }
    return lines.length ? JSON.parse(lines.join("\n")) : undefined;
  };
  const tokenFor = async (server, address, occurrence = 1) => {
    const messages = () => server.messages.filter(message => message.to === address);
    await waitFor(() => messages().length >= occurrence, { what: "SMTP invitation", timeoutMs: 15_000 });
    const text = parseMessage(messages()[occurrence - 1].data).parts.find(part => part.type === "text/plain")?.body;
    const match = /#token=([A-Za-z0-9_-]{43})/u.exec(text ?? "");
    assert.ok(match, "SMTP message contains the invitation link");
    return match[1];
  };

  const platformInput = { email: "platform-recipient@example.test", access: access() };
  const invitation = await cli(["auth", "invite", "--data", JSON.stringify(platformInput)]);
  const listed = await owner.auth.admin.invitations();
  assert.deepEqual(listed, { invitations: [invitation] });
  assert.deepEqual(await cli(["auth", "invitations"]), listed);
  assert.deepEqual(await expectStatus(await owner.request("/auth/invitations"), 200), listed);
  const platformToken = await tokenFor(platformServer, platformInput.email);
  const accepted = await client().auth.acceptInvitation({ token: platformToken, username: "platform-recipient", password: PASSWORD });
  const customer = client(accepted.tokens.accessToken);
  assert.deepEqual((await customer.projects.list()).projects.map(({ id }) => id), [app.id]);
  assert.equal((await expectStatus(await customer.request("/auth/emails"), 200)).emails[0].email, platformInput.email);

  const { token: managerToken } = await owner.auth.serviceAccounts.create({
    name: "App invitations", grants: [grant("project.view"), grant("project.users.manage"), grant("project.runtime.manage")],
  });
  const manager = client(managerToken);
  const appInput = { email: "app-recipient@example.test", access: access([grant("project.view")], "user") };
  const forbidden = { status: 403 };
  await assert.rejects(manager.projects.invite("other-app", appInput), forbidden);
  await assert.rejects(manager.projects.invitations("other-app"), forbidden);
  await assert.rejects(manager.projects.invite(app.id, { ...appInput, access: access([grant("project.domains.manage")], "user") }), forbidden);
  await assert.rejects(manager.projects.invite(app.id, { ...appInput, access: access([grant("project.view", "other-app")], "user") }), forbidden);
  await expectStatus(await manager.request(`/runtime/projects/${app.id}/proxy/zelavis/api/v1/auth/invitations`, {
    method: "POST", body: appInput,
  }), 403);
  assert.deepEqual(await manager.projects.invitations(app.id), { invitations: [] });

  const appInvite = await manager.projects.invite(app.id, appInput);
  assert.deepEqual(await cli(["projects", "invitations", app.id], managerToken), { invitations: [appInvite] });
  await tokenFor(appServer, appInput.email);
  assert.deepEqual(await cli(["projects", "resend-invitation", app.id, appInvite.id], managerToken), appInvite);
  const appToken = await tokenFor(appServer, appInput.email, 2);

  // The external Platform principal cannot be reconstructed by the App and
  // the issued link retains its original scope and expiry.
  await owner.auth.serviceAccounts.revoke((await owner.auth.serviceAccounts.list()).serviceAccounts[0].id);
  const publicApp = createZelavisClient({ baseUrl: app.runtime.url });
  assert.equal((await publicApp.auth.registration.status()).enabled, false);
  const appAccepted = await publicApp.auth.acceptInvitation({ token: appToken, username: "app-recipient", password: PASSWORD });
  assert.notEqual(appAccepted.userId, accepted.userId);
  const appAccount = createZelavisClient({ baseUrl: app.runtime.url, headers: { authorization: `Bearer ${appAccepted.tokens.accessToken}` } });
  assert.deepEqual((await appAccount.auth.session.current()).account.grants, appInput.access.grants);
  await assert.rejects(publicApp.auth.acceptInvitation({ token: platformToken }), { status: 400, body: { error: "This invitation is invalid or no longer available.", code: "invalid_invitation" } });

  const terminal = await owner.projects.invite(app.id, { ...appInput, email: "revoked@example.test" });
  const revoked = await cli(["projects", "revoke-invitation", app.id, terminal.id]);
  assert.equal(revoked.status, "revoked");
  assert.equal((await owner.projects.invitations(app.id)).invitations[0].status, "revoked");
});
