import { Effect, Schema, Semaphore } from "effect";
import { principalHasPermission } from "zelavis/core";
import {
  dateString, dbCall, decode, hostingError, invalid, ok, platformFailure, platformJson, revisionConflict, route,
  strict, subscriptionCollection, table, type HostingStore, type Platform, type Transaction,
} from "./runtime.js";
import type { hostingSettings } from "./settings.js";

export const maximumProjects = 20; // Auth permits one assignment of a role, with up to 20 Projects.
const maximumPlans = 20;
export const projectPermissions = [
  "project.view", "project.runtime.manage", "project.settings.manage", "project.users.manage",
  "project.domains.manage", "project.logs.read", "project.delete",
] as const;
export const suspendedRoleId = "hosting-suspended";
export const planRoleId = (id: string) => `hosting-plan-${id}`;
const suspendedPermissions = ["project.view", "project.logs.read"];
export const PlanId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{1,31}$/u));
export const RecipeName = Schema.String.check(
  Schema.isMaxLength(128), Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);
const fields = {
  title: Schema.String.check(Schema.isBetweenLength(1, 80), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  price: Schema.Struct({
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99_999_999 })),
    currency: Schema.String.check(Schema.isPattern(/^[a-z]{3}$/u)),
    interval: Schema.Literals(["month", "year"]),
  }),
  limits: Schema.Struct({
    projects: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumProjects })),
    recipes: Schema.optional(Schema.Array(RecipeName).check(Schema.isBetweenLength(1, 20), Schema.isUnique())),
  }),
  projectPermissions: Schema.Array(Schema.String).check(Schema.isBetweenLength(1, 30), Schema.isUnique()),
  active: Schema.Boolean,
};
const planSchema = Schema.Struct({ id: PlanId, ...fields, updatedAt: dateString });
export type HostingPlan = typeof planSchema.Type;
const readInput = Schema.decodeUnknownSync(Schema.Struct({ ...fields, updatedAt: Schema.optional(dateString) }), strict);
const plans = table("hosting_plans", Schema.decodeUnknownSync(Schema.Struct({
  current: Schema.optional(planSchema),
  pending: Schema.optional(planSchema),
}).check(Schema.makeFilter(record => record.current !== undefined || record.pending !== undefined))));

const serializePlan = ({ description, limits, ...plan }: HostingPlan) => ({
  ...plan, ...(description === undefined ? {} : { description }),
  limits: { projects: limits.projects, ...(limits.recipes ? { recipes: [...limits.recipes] } : {}) },
  projectPermissions: [...plan.projectPermissions],
});
const serializeRecord = (record: { current?: HostingPlan; pending?: HostingPlan }) => ({
  ...(record.current ? { current: serializePlan(record.current) } : {}),
  ...(record.pending ? { pending: serializePlan(record.pending) } : {}),
});

const readCatalogue = Schema.decodeUnknownSync(Schema.Struct({
  revision: Schema.Natural,
  roles: Schema.Array(Schema.Struct({
    id: Schema.String, title: Schema.String, projectPermissions: Schema.Array(Schema.String),
    permissions: Schema.Array(Schema.String), grants: Schema.Array(Schema.Unknown),
  })),
}));
const samePermissions = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every(value => right.includes(value));

function hostingRoles(platform: Platform) {
  const catalogue = () => platform("GET", "/auth/roles").pipe(Effect.flatMap(response => platformJson(response, readCatalogue)));
  const ensure = Effect.fn(function* (id: string, title: string, permissions: readonly string[], prior?: HostingPlan) {
    const readOnly = id === suspendedRoleId;
    for (let attempt = 0; attempt < 5; attempt++) {
      const { revision, roles } = yield* catalogue();
      const role = roles.find(entry => entry.id === id);
      if (role && role.permissions.length === 0 && role.grants.length === 0) {
        if (role.title === title && samePermissions(role.projectPermissions, permissions)) return;
        if (!readOnly && prior && role.title === prior.title && samePermissions(role.projectPermissions, prior.projectPermissions)) {
          // An existing Hosting role is changed through the catalogue's revision.
        } else {
          return yield* hostingError(409, "hosting_role_conflict", `Custom role ${id} is already in use.`);
        }
      } else if (role) {
        return yield* hostingError(409, "hosting_role_conflict", `Custom role ${id} is already in use.`);
      }
      const input = { id, title, permissions: [], grants: [], projectPermissions: permissions, expectedRevision: revision };
      const response = role
        ? yield* platform("PUT", `/auth/roles/${id}`, input)
        : yield* platform("POST", "/auth/roles", input);
      if (response.ok) return;
      if (response.status !== 409) return yield* platformFailure(response.status);
    }
    return yield* revisionConflict();
  });
  return { catalogue, ensure };
}

export function hostingPlans(store: HostingStore, settings: ReturnType<typeof hostingSettings>, platform: Platform, now: () => number) {
  const roles = hostingRoles(platform);
  const permit = Semaphore.makeUnsafe(1);
  const get = (id: string, tx?: Transaction) => store.get(plans, id, tx);
  const list = () => dbCall(() => store.documents.findMany({ collection: plans.collection, limit: maximumPlans }))
    .pipe(Effect.flatMap(records => Effect.forEach(records, record => plans.read(record.data))));
  const planNotFound = () => hostingError(404, "plan_not_found", "This hosting plan is unavailable.");
  const requirePlan = (id: string, tx?: Transaction) => Effect.gen(function* () {
    const record = yield* get(id, tx);
    if (record?.pending) return yield* revisionConflict();
    if (!record?.current) return yield* planNotFound();
    return record.current;
  });
  const finish = Effect.fn(function* (plan: HostingPlan) {
    const record = yield* get(plan.id);
    if (record?.pending?.updatedAt !== plan.updatedAt) return yield* revisionConflict();
    yield* roles.ensure(suspendedRoleId, "Suspended hosting", suspendedPermissions);
    yield* roles.ensure(planRoleId(plan.id), plan.title, plan.projectPermissions, record.current);
    yield* store.transaction(tx => Effect.gen(function* () {
      const latest = yield* get(plan.id, tx);
      if (latest?.pending?.updatedAt !== plan.updatedAt) return yield* revisionConflict();
      yield* store.put(tx, plans.collection, plan.id, serializeRecord({ current: plan }), true);
    }));
    return plan;
  });
  const reconcile = () => permit.withPermit(Effect.gen(function* () {
    for (const record of yield* list()) {
      if (record.pending) yield* finish(record.pending).pipe(Effect.catch(error =>
        Effect.logWarning("Hosting plan role reconciliation deferred", { planId: record.pending?.id, code: error.code })));
    }
  }));
  const save = (id: string, input: ReturnType<typeof readInput>) => permit.withPermit(Effect.gen(function* () {
    if (!input.title.trim()) return yield* invalid("A plan title is required.");
    if (!input.projectPermissions.every(permission => projectPermissions.some(allowed => allowed === permission))) {
      return yield* hostingError(409, "permission_not_delegable", "The Hosting principal cannot delegate one or more of these Project permissions.");
    }

    const existing = yield* get(id);
    if (existing?.pending || existing?.current?.updatedAt !== input.updatedAt) return yield* revisionConflict();
    const catalogue = yield* roles.catalogue();
    if (!existing && catalogue.roles.some(role => role.id === planRoleId(id))) {
      return yield* hostingError(409, "hosting_role_conflict", `Custom role ${planRoleId(id)} is already in use.`);
    }
    yield* roles.ensure(suspendedRoleId, "Suspended hosting", suspendedPermissions);
    const plan = yield* store.transaction(tx => Effect.gen(function* () {
      const record = yield* get(id, tx);
      if (record?.pending || record?.current?.updatedAt !== input.updatedAt) return yield* revisionConflict();
      if (!record && (yield* dbCall(() => tx.find({ collection: plans.collection, limit: maximumPlans }))).length >= maximumPlans) {
        return yield* hostingError(409, "hosting_plan_count_limit", "This installation already has 20 hosting plans.");
      }
      if (record?.current && input.limits.projects < record.current.limits.projects) {
        const aboveLimit = yield* dbCall(() => tx.find({
          collection: subscriptionCollection, limit: 1,
          where: [{ path: "planId", op: "eq", value: id }, { path: "allocatedProjects", op: "gt", value: input.limits.projects }],
        }));
        if (aboveLimit.length) return yield* hostingError(409, "hosting_plan_limit_in_use",
          "A subscription already uses more Project slots than this limit would allow.");
      }
      const updatedAt = new Date(Math.max(now(), record?.current ? Date.parse(record.current.updatedAt) + 1 : 0)).toISOString();
      const pending = { ...input, title: input.title.trim(), id, updatedAt, projectPermissions: [...input.projectPermissions].sort() };
      const next = { ...record, pending };
      yield* store.put(tx, plans.collection, id, serializeRecord(next), record !== undefined);
      return pending;
    }));
    return yield* finish(plan);
  }));
  const routes = [
    route("plans", "list", "GET", { authenticated: true }, ({ principal }) => Effect.gen(function* () {
      const operator = principalHasPermission(principal, "hosting.manage");
      if (!operator) yield* settings.require();
      const current = (yield* list()).flatMap(record => record.current ? [record.current] : []);
      return ok({ plans: current.filter(plan => operator || plan.active), ...(operator ? { projectPermissions, maximumProjects } : {}) });
    })),
    route("plans", "save", "PUT", { permissions: ["hosting.manage"] }, ({ params, body }) => Effect.gen(function* () {
      const id = yield* decode(Schema.decodeUnknownSync(PlanId), params.planId, "Invalid hosting plan id.");
      const input = yield* decode(readInput, body, "Invalid hosting plan.");
      return ok({ plan: yield* save(id, input) });
    }), "/hosting/plans/:planId"),
  ];
  return { collection: plans.collection, planNotFound, requirePlan, routes, reconcile };
}
