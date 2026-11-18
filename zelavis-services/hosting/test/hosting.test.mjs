import assert from "node:assert/strict";
import test from "node:test";
import { loadHostingPlugin } from "./load-plugin.mjs";
import { hosting, permissions, platform, readyBilling, starter, webhook } from "./billing-fixture.mjs";


test("Hosting loads from its package and requires Ecommerce and exact principal approval", async (t) => {
  const plugin = await loadHostingPlugin();
  assert.equal(plugin.name, "@zelavis/hosting");
  assert.equal(permissions.length, 10);
  const { service } = await platform(t);
  const missing = await service("@zelavis/hosting", "installed", permissions);
  assert.equal(missing.status, 400, JSON.stringify(missing));
  assert.match(JSON.stringify(missing.body), /extends @zelavis\/ecommerce, which is not installed/);
  const commerce = await service("@zelavis/ecommerce", "installed");
  assert.equal(commerce.status, 200, JSON.stringify(commerce));
  const unapproved = await service("@zelavis/hosting", "installed");
  assert.equal(unapproved.status, 409, JSON.stringify(unapproved));
  assert.equal(unapproved.body.error, "principal_approval_required");
  assert.deepEqual(unapproved.body.permissions, permissions);
  const approved = await service("@zelavis/hosting", "installed", permissions);
  assert.equal(approved.status, 200, JSON.stringify(approved));
  const disable = await service("@zelavis/ecommerce", "available");
  assert.equal(disable.status, 400, JSON.stringify(disable));
  assert.match(JSON.stringify(disable.body), /@zelavis\/hosting; disable them first/);
});

const customer = { id: "customer", type: "user", permissions: [] };
async function installedPlatform(t) {
  const fixture = await platform(t);
  for (const [name, approval] of [["@zelavis/ecommerce"], ["@zelavis/ecommerce-stripe"], ["@zelavis/hosting", permissions]]) {
    const result = await fixture.service(name, "installed", approval);
    assert.equal(result.status, 200, JSON.stringify(result));
  }
  return fixture;
}

test("settings require operator authority and a registered payment provider", async (t) => {
  const { send } = await installedPlatform(t);
  const input = { publicBaseUrl: "https://hosting.example/", provider: "stripe" };
  assert.equal((await send("GET", `${hosting}/settings`, undefined, customer)).status, 403);
  assert.equal((await send("PUT", `${hosting}/settings`, input, customer)).status, 403);
  assert.equal((await send("GET", `${hosting}/plans`, undefined, null)).status, 401);
  const unconfigured = await send("GET", `${hosting}/plans`, undefined, customer);
  assert.equal(unconfigured.status, 503);
  assert.equal(unconfigured.body.error, "hosting_not_configured");
  for (const settings of [{ ...input, provider: "unknown" }, { ...input, publicBaseUrl: "http://hosting.example" }, { ...input, graceDays: 31 }]) {
    assert.equal((await send("PUT", `${hosting}/settings`, settings)).status, 400);
  }
  const result = await send("PUT", `${hosting}/settings`, input);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(result.body.settings.graceDays, 7);
  assert.equal(result.body.settings.publicBaseUrl, "https://hosting.example");
  assert.deepEqual((await send("GET", `${hosting}/settings`)).body, result.body);
});


test("plan saves write scoped Auth roles and enforce optimistic revisions and delegation", async (t) => {
  const { send } = await installedPlatform(t);
  const path = `${hosting}/plans/starter`;
  assert.equal((await send("PUT", path, starter, customer)).status, 403);
  const refused = await send("PUT", path, { ...starter, projectPermissions: ["project.view", "projects.create"] });
  assert.equal(refused.status, 409, JSON.stringify(refused));
  assert.equal(refused.body.error, "permission_not_delegable");
  assert.equal((await send("PUT", path, { ...starter, limits: { projects: 21 } })).status, 400);
  const saved = await send("PUT", path, starter);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const catalogue = await send("GET", "/auth/roles");
  const planRole = catalogue.body.roles.find(role => role.id === "hosting-plan-starter");
  assert.deepEqual(planRole.projectPermissions, [...starter.projectPermissions].sort());
  assert.deepEqual(planRole.permissions, []);
  const suspended = catalogue.body.roles.find(role => role.id === "hosting-suspended");
  assert.deepEqual(suspended.projectPermissions, ["project.logs.read", "project.view"]);
  const edited = await send("PUT", path, { ...starter, title: "New title", updatedAt: saved.body.plan.updatedAt });
  assert.equal(edited.status, 200, JSON.stringify(edited));
  const stale = await send("PUT", path, { ...starter, updatedAt: saved.body.plan.updatedAt });
  assert.equal(stale.status, 409, JSON.stringify(stale));
  assert.equal(stale.body.error, "hosting_revision_conflict");
});


test("Ecommerce verified checkout activates only the owning Hosting subscription", async t => {
  const { instance, billing, createCustomer, postEvent, complete } = await readyBilling(t);
  const alice = await createCustomer("alice");
  const bob = await createCustomer("bob");
  assert.deepEqual((await alice.client.plugins.hosting.plans.list()).plans.map(plan => plan.id), ["starter"]);
  assert.equal((await alice.client.request(`${hosting}/subscriptions`)).status, 403);
  const create = () => alice.client.plugins.hosting.checkout.create({ planId: "starter" });
  const first = await create();
  assert.match(first.url, /^https:\/\/checkout\.example\//);
  assert.deepEqual(await create(), first);
  assert.equal(billing.checkouts.length, 1);
  const get = () => alice.client.plugins.hosting.subscription.get();
  assert.equal((await get()).subscription.state, "pending");
  assert.equal((await bob.client.request(`${hosting}/subscription`)).status, 404);
  const invalid = await webhook(instance, [], false);
  assert.equal(invalid.status, 400);
  assert.equal((await get()).subscription.state, "pending");
  const checkout = await complete();
  const active = (await get()).subscription;
  assert.equal(active.state, "active");
  assert.deepEqual((await alice.client.plugins.hosting.portal.create()).url, `https://billing.example/${checkout.customer.id}`);
  await postEvent({ eventId: `checkout-${checkout.checkoutId}`, type: "checkout.completed", occurredAt: new Date(billing.now).toISOString(),
    checkoutReference: `cs_${checkout.checkoutId}`, subscriptionReference: `sub_${checkout.checkoutId}` });
  await postEvent({ eventId: "stale", type: "subscription.updated", status: "past_due", cancelAtPeriodEnd: false,
    subscriptionReference: `sub_${checkout.checkoutId}`, occurredAt: new Date(billing.now - 1).toISOString() });
  assert.deepEqual((await get()).subscription, active);
});

async function subscribe(createCustomer, complete, name) {
  const member = await createCustomer(name);
  await member.client.plugins.hosting.checkout.create({ planId: "starter" });
  const checkout = await complete();
  assert.equal((await member.client.plugins.hosting.subscription.get()).subscription.state, "active");
  return { member, checkout };
}

const expectHttp = (status, error) => failure => failure.status === status && (error === undefined || failure.body.error === error);

test("eight competing creates allocate exactly two slots, and deleting a billed Project frees a slot", async t => {
  const { send, createCustomer, complete } = await readyBilling(t, { projects: { previewHost: false } });
  const { member } = await subscribe(createCustomer, complete, "tenant");
  const outsider = await createCustomer("outsider");
  await assert.rejects(outsider.client.plugins.hosting.projects.list(), expectHttp(404));
  await assert.rejects(member.client.projects.create({ name: "Direct create" }), expectHttp(403));
  const create = input => member.client.plugins.hosting.projects.create(input);
  await assert.rejects(create({ name: "Unavailable recipe", recipeName: "@zelavis/wordpress" }), expectHttp(409, "recipe_not_in_plan"));
  // The generic SDK discovers before dispatch. One discovery request per call is allowed to finish before the concurrent mutation.
  const calls = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    send("POST", `${hosting}/projects`, { name: `Billed ${index}` }, { id: member.id, type: "user" })));
  const created = calls.filter(result => result.status === 201);
  assert.equal(created.length, 2, JSON.stringify(calls));
  assert.ok(calls.filter(result => result.status !== 201).every(result => result.status === 409 && result.body.error === "plan_limit_reached"));
  const unrelated = await send("POST", "/runtime/projects", { name: "Unrelated", start: false });
  assert.equal(unrelated.status, 201);
  let signedIn = await member.signIn();
  const ids = created.map(result => result.body.projectId);
  const listed = await signedIn.plugins.hosting.projects.list();
  assert.equal(listed.limit, 2);
  assert.deepEqual(listed.projects.map(project => project.id).sort(), [...ids].sort());
  assert.deepEqual((await signedIn.projects.list()).projects.map(project => project.id).sort(), [...ids].sort());
  assert.equal((await signedIn.projects.start(ids[0])).runtime.status, "running");
  await assert.rejects(outsider.client.projects.get(ids[0]), expectHttp(403));
  await assert.rejects(signedIn.projects.get(unrelated.body.project.id), expectHttp(403));
  await assert.rejects(signedIn.plugins.hosting.projects.create({ name: "One too many" }), expectHttp(409, "plan_limit_reached"));

  const tooSmall = await send("PUT", `${hosting}/plans/starter`, {
    ...starter, limits: { ...starter.limits, projects: 1 },
    updatedAt: (await signedIn.plugins.hosting.subscription.get()).plan.updatedAt,
  });
  assert.equal(tooSmall.status, 409, JSON.stringify(tooSmall));
  assert.equal(tooSmall.body.error, "hosting_plan_limit_in_use");

  await signedIn.projects.remove(ids[0]);
  await poll(async () => {
    const subscription = await send("GET", `${hosting}/subscriptions`);
    return subscription.body.subscriptions[0]?.billedProjects.length === 1;
  }, "cleanup of the deleted Project");
  signedIn = await member.signIn();
  const plan = (await signedIn.plugins.hosting.subscription.get()).plan;
  const reduced = await send("PUT", `${hosting}/plans/starter`, {
    ...starter, limits: { ...starter.limits, projects: 1 }, updatedAt: plan.updatedAt,
  });
  assert.equal(reduced.status, 200, JSON.stringify(reduced));
  await assert.rejects(signedIn.plugins.hosting.projects.create({ name: "Now full" }), expectHttp(409, "plan_limit_reached"));
  assert.equal((await send("PUT", `${hosting}/plans/starter`, { ...starter, updatedAt: reduced.body.plan.updatedAt })).status, 200);
  assert.match((await signedIn.plugins.hosting.projects.create({ name: "Replacement" })).projectId, /^h-/);
});

async function poll(predicate, description) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test("a failed account grant is picked up from the created provision without creating another Project", async t => {
  const { send, billing, createCustomer, complete } = await readyBilling(t, { projects: { previewHost: false } });
  const { member } = await subscribe(createCustomer, complete, "recover");
  let attempted = 0;
  billing.platformFetch = (request, fetch) => {
    if (new URL(request.url).pathname.endsWith("/runtime/projects") && request.method === "POST") attempted++;
    if (request.method === "PUT" && new URL(request.url).pathname.endsWith("/access") && attempted === 1) {
      billing.platformFetch = undefined;
      return Promise.resolve(Response.json({}, { status: 503 }));
    }
    return fetch(request);
  };
  await assert.rejects(member.client.plugins.hosting.projects.create({ name: "Recover this" }), expectHttp(502, "platform_call_failed"));
  await poll(async () => {
    const account = await send("GET", `/auth/accounts?accountId=${member.id}`);
    return account.body.accounts[0]?.roleAssignments.some(role => role.roleId === "hosting-plan-starter" && role.projectIds.length === 1);
  }, "the original Project's account grant");
  const ownerProjects = await send("GET", "/runtime/projects");
  assert.equal(ownerProjects.body.projects.length, 1);
  assert.equal(attempted, 1);
  assert.equal((await (await member.signIn()).plugins.hosting.projects.list()).projects.length, 1);
});

test("grace preserves access, then suspension stops Projects, and payment restores only access", async t => {
  const { instance, send, service, billing, createCustomer, complete, postEvent } = await readyBilling(t, { projects: { previewHost: false } });
  const { member, checkout } = await subscribe(createCustomer, complete, "late");
  const { projectId } = await member.client.plugins.hosting.projects.create({ name: "Paid Project" });
  billing.now += 1000;
  const update = (eventId, status, fields = {}) => postEvent({
    eventId, type: "subscription.updated", subscriptionReference: `sub_${checkout.checkoutId}`,
    occurredAt: new Date(billing.now).toISOString(), status, cancelAtPeriodEnd: false, ...fields,
  });
  const graceStart = billing.now;
  const events = [graceStart, graceStart + 1000].map((date, index) => ({
    eventId: `past-due-${index}`, type: "subscription.updated", subscriptionReference: `sub_${checkout.checkoutId}`,
    occurredAt: new Date(date).toISOString(), status: "past_due", cancelAtPeriodEnd: false,
  }));
  assert.equal((await webhook(instance, events)).status, 200);
  billing.now += 1000;
  await billing.commerce.runPromise(billing.commerce.fulfillment.deliver());
  const duringGrace = await member.signIn();
  const { subscription } = await duringGrace.plugins.hosting.subscription.get();
  assert.equal(subscription.state, "past_due");
  assert.equal(Date.parse(subscription.graceEndsAt), graceStart + 7 * 86_400_000);
  assert.equal((await duringGrace.projects.start(projectId)).runtime.status, "running");
  assert.equal((await duringGrace.request(`/runtime/projects/${projectId}/logs`)).status, 200);
  await assert.rejects(duringGrace.plugins.hosting.projects.create({ name: "Overdue" }), expectHttp(402, "subscription_inactive"));
  billing.now += 86_400_000;
  await update("failed-again", "past_due");
  assert.equal((await duringGrace.plugins.hosting.subscription.get()).subscription.graceEndsAt, subscription.graceEndsAt);
  let failedStop = false;
  billing.platformFetch = (request, fetch) => {
    if (new URL(request.url).pathname.endsWith(`/${projectId}/stop`) && !failedStop) {
      failedStop = true;
      return Promise.resolve(Response.json({}, { status: 503 }));
    }
    return fetch(request);
  };
  billing.now = Date.parse(subscription.graceEndsAt) + 1;
  const project = () => send("GET", `/runtime/projects/${projectId}`);
  await poll(async () => (await project()).body.project?.runtime.status === "stopped", "the suspended Project to stop");
  assert.equal(failedStop, true);
  const suspended = await member.signIn();
  assert.equal((await suspended.plugins.hosting.subscription.get()).subscription.state, "suspended");
  assert.equal((await suspended.projects.get(projectId)).runtime.status, "stopped");
  assert.equal((await suspended.request(`/runtime/projects/${projectId}/logs`)).status, 200);
  await assert.rejects(suspended.projects.start(projectId), expectHttp(403));
  await assert.rejects(suspended.projects.remove(projectId), expectHttp(403));

  billing.now += 1000;
  await update("paid-again", "active");
  const account = () => send("GET", `/auth/accounts?accountId=${member.id}`);
  await poll(async () => (await account()).body.accounts[0]?.roleAssignments.some(role => role.roleId === "hosting-plan-starter"),
    "the renewed plan role");
  const renewed = await member.signIn();
  assert.equal((await renewed.plugins.hosting.subscription.get()).subscription.state, "active");
  assert.equal((await renewed.projects.get(projectId)).runtime.status, "stopped");

  await renewed.projects.start(projectId);
  const beforeDisable = (await account()).body.accounts[0].roleAssignments;
  const disabled = await service("@zelavis/hosting", "available");
  assert.equal(disabled.status, 200, JSON.stringify(disabled));
  assert.equal((await send("GET", `${hosting}/settings`)).status, 404);
  assert.deepEqual((await account()).body.accounts[0].roleAssignments, beforeDisable);
  assert.equal((await project()).body.project.runtime.status, "running");
});
