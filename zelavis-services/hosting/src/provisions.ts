import { Effect, Schema } from "effect";
import type { DocumentCursor } from "zelavis/db";
import { human, type accountAccess } from "./accounts.js";
import { planRoleId, RecipeName, suspendedRoleId, type hostingPlans } from "./plans.js";
import { dateString, dbCall, decode, hostingError, ok, platformFailure, platformJson, route, strict, table, type HostingStore, type Platform, type Transaction } from "./runtime.js";
import { canProvision, inactive, type hostingSubscriptions } from "./subscriptions.js";

const name = Schema.String.check(Schema.isBetweenLength(1, 120), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u));
const readInput = Schema.decodeUnknownSync(Schema.Struct({ name, recipeName: Schema.optional(RecipeName) }), strict);
const provisionSchema = Schema.Struct({
  principalId: Schema.String.check(Schema.isBetweenLength(1, 200)),
  projectId: Schema.String.check(Schema.isPattern(/^h-[a-z2-7]{12}$/u)),
  name, recipeName: RecipeName, state: Schema.Literals(["reserved", "created", "granted", "released"]),
  createdAt: dateString, updatedAt: dateString,
});
type Provision = typeof provisionSchema.Type;
const provisions = table("hosting_provisions", Schema.decodeUnknownSync(provisionSchema));
const readProject = Schema.decodeUnknownSync(Schema.Struct({
  project: Schema.Struct({
    id: Schema.String, name: Schema.String, recipe: Schema.Struct({ name: Schema.String }),
    runtime: Schema.Struct({ status: Schema.String }),
  }),
}));
const base32 = "abcdefghijklmnopqrstuvwxyz234567";
const generatedId = () => `h-${Array.from(crypto.getRandomValues(new Uint8Array(12)), value => base32[value & 31]).join("")}`;
export const projectPath = (id: string) => `/runtime/projects/${encodeURIComponent(id)}`;
const nativeRecipe = "@zelavis/app";
const retryReservationMs = 600_000;

export function hostingProvisions(
  store: HostingStore, plans: ReturnType<typeof hostingPlans>, subscriptions: ReturnType<typeof hostingSubscriptions>,
  accounts: ReturnType<typeof accountAccess>, platform: Platform, now: () => number,
) {
  const timestamp = () => new Date(now()).toISOString();
  const reserve = Effect.fn(function* (principalId: string, input: ReturnType<typeof readInput>) {
    const recipeName = input.recipeName ?? nativeRecipe;
    const projectId = generatedId();
    const createdAt = timestamp();
    const provision: Provision = { principalId, projectId, name: input.name, recipeName,
      state: "reserved", createdAt, updatedAt: createdAt };
    yield* store.transaction(tx => Effect.gen(function* () {
      const customer = yield* subscriptions.get(principalId, tx);
      if (!canProvision(customer, now())) return yield* inactive();
      const plan = yield* plans.requirePlan(customer.planId, tx);
      if (plan.limits.recipes && !plan.limits.recipes.includes(recipeName)) {
        return yield* hostingError(409, "recipe_not_in_plan", "This Project recipe is outside your hosting plan.");
      }
      if (customer.billedProjects.length + customer.reserved >= plan.limits.projects) {
        return yield* hostingError(409, "plan_limit_reached", "Your hosting plan has no available Project slots.");
      }
      yield* subscriptions.put(tx, { ...customer, reserved: customer.reserved + 1, updatedAt: createdAt });
      yield* store.put(tx, provisions.collection, projectId, provision, false);
    }));
    return provision;
  });

  const getProject = Effect.fn(function* (id: string) {
    const response = yield* platform("GET", projectPath(id));
    if (response.status === 404) return undefined;
    const { project } = yield* platformJson(response, readProject);
    if (project.id !== id) return yield* platformFailure(response.status);
    return project;
  });

  const write = (tx: Transaction, provision: Provision, state: Provision["state"]) =>
    store.put(tx, provisions.collection, provision.projectId, { ...provision, state, updatedAt: timestamp() }, true);

  const release = (provision: Provision) => store.transaction(tx => Effect.gen(function* () {
    const current = yield* store.get(provisions, provision.projectId, tx);
    const customer = yield* subscriptions.require(provision.principalId, tx);
    if (current?.state !== "reserved" || customer.reserved < 1) return yield* platformFailure(409);
    yield* subscriptions.put(tx, { ...customer, reserved: customer.reserved - 1, updatedAt: timestamp() });
    yield* write(tx, current, "released");
  }));

  const syncRoles = (customer: NonNullable<Effect.Success<ReturnType<typeof subscriptions.get>>>, projectIds = customer.billedProjects) =>
    accounts.assign(customer.principalId,
      customer.state === "suspended" ? suspendedRoleId : planRoleId(customer.planId), projectIds,
      [suspendedRoleId, planRoleId(customer.planId)]);

  const grantProject = Effect.fn(function* (provision: Provision) {
    const customer = yield* store.transaction(tx => Effect.gen(function* () {
      const latest = yield* subscriptions.require(provision.principalId, tx);
      if (latest.billedProjects.includes(provision.projectId)) return latest;
      if (latest.reserved < 1) return yield* platformFailure(409);
      const updated = { ...latest, reserved: latest.reserved - 1,
        billedProjects: [...latest.billedProjects, provision.projectId], updatedAt: timestamp(),
        ...(latest.state === "suspended" ? { entitlementsPending: true, reviewAfter: timestamp() } : {}) };
      yield* subscriptions.put(tx, updated);
      return updated;
    }));
    yield* syncRoles(customer);
    yield* store.transaction(tx => write(tx, provision, "granted"));
  });

  const fulfill = (provision: Provision, reconcile: boolean) => subscriptions.permitFor(provision.principalId).withPermit(Effect.gen(function* () {
    const current = yield* store.get(provisions, provision.projectId);
    if (current?.state === "granted") return true;
    if (!current || current.state === "released") return false;
    if (current.state === "reserved") {
      // A first attempt already owns a fresh id. Recovery after a crash must check the Platform first.
      if (reconcile && now() - Date.parse(current.createdAt) < retryReservationMs) return false;
      const existing = reconcile ? yield* getProject(current.projectId) : undefined;
      if (existing && (existing.name !== current.name || existing.recipe.name !== current.recipeName)) {
        yield* release(current);
        return yield* platformFailure(409);
      }
      if (!existing) {
        const customer = yield* subscriptions.require(current.principalId);
        if (!canProvision(customer, now())) {
          yield* release(current);
          if (reconcile) return false;
          return yield* inactive();
        }
        const response = yield* platform("POST", "/runtime/projects", {
          id: current.projectId, name: current.name, recipeName: current.recipeName, start: true,
        });
        if (!response.ok) {
          // A validation refusal can be freed only after proving that no Project was created.
          if (response.status === 400 && !(yield* getProject(current.projectId))) yield* release(current);
          return yield* platformFailure(response.status);
        }
      }
      yield* store.transaction(tx => write(tx, current, "created"));
    }
    yield* grantProject(current);
    return true;
  }));

  const removeMissing = Effect.fn(function* (principalId: string) {
    const customer = yield* subscriptions.get(principalId);
    if (!customer?.billedProjects.length) return customer;
    const projects = yield* Effect.forEach(customer.billedProjects, getProject, { concurrency: 4 });
    const existing = projects.flatMap(project => project ? [project.id] : []);
    if (existing.length === customer.billedProjects.length) return customer;
    yield* syncRoles(customer, existing);
    return yield* store.transaction(tx => Effect.gen(function* () {
      const latest = yield* subscriptions.require(principalId, tx);
      const next = { ...latest, billedProjects: existing, updatedAt: timestamp() };
      yield* subscriptions.put(tx, next);
      return next;
    }));
  });

  let provisionCursor: DocumentCursor | undefined;
  let projectCursor: DocumentCursor | undefined;
  const report = (operation: string) => Effect.catch((error: { code: string }) =>
    Effect.logWarning(`Hosting ${operation} deferred`, { code: error.code }));
  const reconcile = () => Effect.gen(function* () {
    const page = yield* dbCall(() => store.documents.findPage({
      collection: provisions.collection, limit: 20, after: provisionCursor,
      where: [{ path: "state", op: "in", value: ["reserved", "created"] }],
    }));
    for (const item of page.documents) {
      yield* provisions.read(item.data).pipe(Effect.flatMap(provision => fulfill(provision, true)), report("provision"));
    }
    provisionCursor = page.next;
    // At most 40 Project lookups, with the cursor advancing even if a customer's repair is deferred.
    const sweep = yield* subscriptions.page({ limit: 2, after: projectCursor });
    for (const customer of sweep.items) {
      yield* subscriptions.permitFor(customer.principalId).withPermit(removeMissing(customer.principalId)).pipe(report("Project cleanup"));
    }
    projectCursor = sweep.next;
  });

  const routes = [
    route("projects", "list", "GET", { authenticated: true }, ({ principal }) => Effect.gen(function* () {
      const id = yield* human(principal);
      const customer = yield* subscriptions.require(id);
      const plan = yield* plans.requirePlan(customer.planId);
      const projects = yield* Effect.forEach(customer.billedProjects, getProject, { concurrency: 4 });
      return ok({ limit: plan.limits.projects, reserved: customer.reserved, projects: projects.flatMap(project =>
        project ? [{ id: project.id, name: project.name, recipeName: project.recipe.name, status: project.runtime.status }] : []) });
    })),
    route("projects", "create", "POST", { authenticated: true }, ({ principal, body }) => Effect.gen(function* () {
      const id = yield* human(principal);
      const input = yield* decode(readInput, body, "Supply a Project name and optionally a recipe name.");
      const normalized = yield* decode(Schema.decodeUnknownSync(name), input.name.trim(), "A Project name is required.");
      const provision = yield* reserve(id, { ...input, name: normalized });
      if (!(yield* fulfill(provision, false))) return yield* inactive();
      return ok({ projectId: provision.projectId }, 201);
    })),
  ];
  return { collection: provisions.collection, reconcile, removeMissing, syncRoles, routes };
}
