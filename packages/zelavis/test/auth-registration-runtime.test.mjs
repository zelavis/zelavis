import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nodeAdapter } from "../dist/adapters/node.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { Zelavis } from "../dist/index.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";

const password = "a strong replacement password for registration";

test("two native Apps and their Platform persist independent signup policies and sessions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-registration-"));
  const bootstrapToken = "native-registration-bootstrap-token-long-enough";
  const platformOrigin = "http://registration-platform.test";
  const createPlatform = () => new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }),
    bootstrap: { token: bootstrapToken },
  });
  let zv = createPlatform();
  t.after(async () => {
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const through = (input, init) => zv.fetch(new Request(input, init));
  const platformClient = (token) => createZelavisClient({
    baseUrl: platformOrigin,
    fetch: through,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  const publicPlatform = platformClient();
  const { tokens: ownerSession } = await publicPlatform.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
  const owner = platformClient(ownerSession.accessToken);
  const closed = { enabled: false, providers: [] };
  const open = { enabled: true, providers: ["usernamePassword"] };
  const enable = { enabled: true, expectedRevision: 0 };
  const one = await owner.projects.create({ id: "registration-one", name: "One", recipeName: "@zelavis/app" });
  const two = await owner.projects.create({ id: "registration-two", name: "Two", recipeName: "@zelavis/app" });
  const native = (project, token) => createZelavisClient({
    baseUrl: project.runtime.url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  let appOne = native(one);
  const appTwo = native(two);
  assert.deepEqual(await publicPlatform.auth.registration.status(), closed);
  assert.deepEqual(await appOne.auth.registration.status(), closed);
  assert.deepEqual(await appTwo.auth.registration.status(), closed);

  const { token: settingsToken } = await owner.auth.serviceAccounts.create({
    name: "Signup delegate",
    grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: one.id } }],
  });
  const delegate = platformClient(settingsToken);
  const runProjectCli = async (args) => {
    const fetch = globalThis.fetch;
    const log = console.log;
    const lines = [];
    globalThis.fetch = (input, init) => new URL(input instanceof Request ? input.url : String(input)).origin === platformOrigin
      ? through(input, init)
      : fetch(input, init);
    console.log = (...parts) => lines.push(parts.join(" "));
    try {
      await runProjectsCommand([...args, "--url", `${platformOrigin}/zelavis`, "--token", settingsToken, "--json"]);
    } finally {
      globalThis.fetch = fetch;
      console.log = log;
    }
    return JSON.parse(lines.join("\n"));
  };
  assert.deepEqual(await runProjectCli(["registration-settings", one.id]), { enabled: false, revision: 0 });
  assert.deepEqual(await runProjectCli(["set-registration-settings", one.id, "--data", JSON.stringify(enable)]), { enabled: true, revision: 1 });
  assert.deepEqual(await delegate.projects.registrationSettings(one.id), { enabled: true, revision: 1 });
  await assert.rejects(delegate.projects.setRegistrationSettings(one.id, enable), { status: 409 });
  await assert.rejects(delegate.projects.registrationSettings(two.id), { status: 403 });
  await assert.rejects(delegate.projects.setRegistrationSettings(two.id, enable), { status: 403 });
  await assert.rejects(delegate.auth.registration.settings(), { status: 403 });
  assert.deepEqual(await appOne.auth.registration.status(), open);
  assert.deepEqual(await appTwo.auth.registration.status(), closed);
  assert.deepEqual(await publicPlatform.auth.registration.status(), closed);

  await owner.projects.setRegistrationSettings(two.id, enable);
  await owner.auth.registration.setSettings(enable);
  const input = { username: "shared", password };
  const browser = await through(`${platformOrigin}/zelavis/api/v1/auth/username-password/sign-up`, {
    method: "POST", headers: { "content-type": "application/json", origin: platformOrigin }, body: JSON.stringify(input),
  });
  assert.equal(browser.status, 200);
  assert.equal(browser.headers.get("cache-control"), "no-store");
  assert.match(browser.headers.get("set-cookie"), /HttpOnly/);
  const customer = await browser.json();
  const a = await appOne.auth.usernamePassword.signUp(input);
  const b = await appTwo.auth.usernamePassword.signUp(input);
  assert.equal(new Set([a.userId, b.userId, customer.userId]).size, 3);
  for (const [project, entry] of [[one, a], [two, b]]) {
    const { account } = await native(project, entry.tokens.accessToken).auth.session.current();
    assert.deepEqual(account.roles, ["user"]);
    assert.deepEqual(account.grants, []);
  }
  assert.equal(customer.tokens, undefined);
  const platformUser = await publicPlatform.auth.usernamePassword.signIn(input);
  assert.deepEqual((await platformClient(platformUser.tokens.accessToken).auth.session.current()).account.roles, ["customer"]);
  await assert.rejects(platformClient(platformUser.tokens.accessToken).projects.get(one.id), { status: 403 });
  assert.equal((await owner.auth.bootstrap.status()).required, false);
  await assert.rejects(native(two, a.tokens.accessToken).auth.session.current(), { status: 401 });
  await assert.rejects(platformClient(a.tokens.accessToken).auth.session.current(), { status: 401 });

  const restarted = await owner.projects.restart(one.id);
  appOne = native(restarted);
  assert.deepEqual(await owner.projects.registrationSettings(one.id), { enabled: true, revision: 1 });
  assert.deepEqual(await appOne.auth.registration.status(), open);
  assert.equal((await appOne.auth.usernamePassword.signIn(input)).userId, a.userId);
  await owner.projects.setRegistrationSettings(one.id, { enabled: false, expectedRevision: 1 });
  assert.deepEqual(await appOne.auth.registration.status(), closed);
  await assert.rejects(appOne.auth.usernamePassword.signUp(input), { status: 403 });
  assert.equal((await appOne.auth.usernamePassword.signIn(input)).userId, a.userId);
  assert.deepEqual(await appTwo.auth.registration.status(), open);

  await zv.close();
  zv = createPlatform();
  assert.deepEqual(await owner.auth.registration.settings(), { enabled: true, revision: 1 });
  assert.equal((await publicPlatform.auth.usernamePassword.signIn(input)).userId, customer.userId);
});
