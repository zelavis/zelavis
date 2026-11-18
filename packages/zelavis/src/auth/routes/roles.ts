/**
 * The role routes (Zelavis-own), mounted under `/auth` beside the account
 * routes: `GET|POST /auth/roles`, `PUT|DELETE /auth/roles/:roleId`.
 *
 * Each change runs one transaction (`../roles/roles.ts`); once it returns, the
 * runtime's in-process catalogue copy is cleared, so the next request of every
 * member is expanded from the new roles. A Platform principal acting in an
 * App through the Gateway brings a digest that binds the exact operation and
 * the permission names the Gateway checked it may hand out; the App compares
 * it with the names it computes from its own catalogue before the change.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { ZelavisAccessRequirement, ZelavisPrincipal, ZelavisPrincipalGrant, ZelavisRouteContext, ZelavisRouteResponse, ZelavisServerRoute } from "../../core/index.js";
import { principalHasPermission } from "../../core/runtime/request-dispatcher.js";
import { projectAccountAccessProof } from "../access/access.js";
import { type AdministrationContext, resolveActor } from "../access/delegation.js";
import type { CoreRuntime } from "../core/context.js";
import type { AuthFailure } from "../core/errors.js";
import { sha256Hex } from "../lib/crypto.js";
import type { RoleCatalogueCache } from "../roles/cache.js";
import {
  type CatalogueRead,
  ROLE_BODY_BYTES,
  RoleDefinitionInputSchema,
  type RoleDefinitionInput,
  catalogueView,
  logUnreadable,
  readCatalogue,
  roleCatalogueJsonSchema,
  roleDefinitionInputJsonSchema,
} from "../roles/catalogue.js";
import { type RoleChange, createRole, deleteRole, normalizeRoleContent, roleContentPermissions, updateRole } from "../roles/roles.js";
import { callOf } from "./core.js";
import { errorBody, noStore, respond } from "./errors.js";

const strict = { onExcessProperty: "error" } as const;

export const ROLE_REFUSALS: Readonly<Record<string, readonly [number, string]>> = {
  invalid_role: [400, "Invalid role."],
  role_exists: [409, "A role with that id exists."],
  role_not_found: [404, "Role not found."],
  role_revision_conflict: [409, "The role catalogue has changed; reload it and try again."],
  role_limit: [429, "This runtime already has the most roles it may have."],
  role_expansion_limit: [400, "The access would expand to more permissions and grants than an account may hold."],
  roles_unavailable: [503, "A stored role cannot be read; role administration is unavailable until it is repaired."],
  account_access_forbidden: [403, "The caller cannot delegate this role."],
};

export const roleRefused = (refusal: { readonly code: string; readonly message?: string | undefined }): ZelavisRouteResponse => {
  const known = ROLE_REFUSALS[refusal.code];
  return errorBody(known?.[0] ?? 400, refusal.code, refusal.message ?? known?.[1] ?? "The request was refused.");
};

/** Decodes a role change (body or CLI `--data`), refusing fields it does not know; undefined when invalid. */
export function decodeRoleInput(body: unknown): RoleDefinitionInput | undefined {
  const decoded = Schema.decodeUnknownExit(RoleDefinitionInputSchema, strict)(body);
  return Exit.isSuccess(decoded) ? { id: decoded.value.id, ...normalizeRoleContent(decoded.value), expectedRevision: decoded.value.expectedRevision } : undefined;
}

/** A revision from the query string, or undefined when absent or malformed. */
export const revisionOf = (value: string | null): number | undefined =>
  value !== null && /^\d{1,15}$/u.test(value) ? Number(value) : undefined;

/** What the Gateway signs for an App role operation: the method, the path, the change and the permissions it checked. */
export const roleGatewayDigest = (method: string, path: string, change: RoleDefinitionInput | number | undefined, permissions: ReadonlyArray<string>) =>
  sha256Hex(JSON.stringify(["role", method, path, change ?? null, permissions]));

export const roleOperations = [
  { action: "list", method: "GET", path: "/roles", operationId: "listRoles", summary: "List the custom roles of this runtime", status: 200 },
  { action: "create", method: "POST", path: "/roles", operationId: "createRole", summary: "Define a custom role", status: 201, body: true },
  { action: "update", method: "PUT", path: "/roles/:roleId", operationId: "updateRole", summary: "Change a custom role", status: 200, body: true, hasId: true },
  { action: "delete", method: "DELETE", path: "/roles/:roleId", operationId: "deleteRole", summary: "Delete a custom role", status: 200, hasId: true },
] as const;
export type RoleOperation = typeof roleOperations[number];

export function roleOperationSpec(operation: RoleOperation, gateway = false): Pick<ZelavisServerRoute, "spec" | "maxRequestBodyBytes" | "invalidJsonBodyCode"> {
  return {
    ...("body" in operation ? { maxRequestBodyBytes: ROLE_BODY_BYTES, invalidJsonBodyCode: "invalid_role" } : {}),
    spec: {
      operationId: gateway ? `project${operation.operationId[0]?.toUpperCase()}${operation.operationId.slice(1)}` : operation.operationId,
      summary: gateway ? `${operation.summary.replace(" of this runtime", "")} of a Project's App` : operation.summary,
      tags: gateway ? ["runtime", "auth"] : ["auth", "roles"],
      pathParams: {
        ...(gateway ? { projectId: { type: "string", required: true } } : {}),
        ...("hasId" in operation ? { roleId: { type: "string", required: true } } : {}),
      },
      ...(operation.action === "delete" ? { queryParams: { revision: { type: "integer", required: true, description: "The catalogue revision the deletion is made against." } } } : {}),
      ...("body" in operation ? { requestBody: { required: true, schema: roleDefinitionInputJsonSchema } } : {}),
      responses: {
        [operation.status]: { description: "The role catalogue and its revision", schema: roleCatalogueJsonSchema },
        400: { description: "Invalid role or revision" },
        403: { description: "Role administration or delegation forbidden" },
        404: { description: "Role not found" },
        409: { description: "Role exists or the catalogue revision has changed" },
        429: { description: "Role limit reached" },
        503: { description: "A stored role cannot be read, or Auth is busy" },
      },
    },
  };
}

export interface RoleRoutesOptions {
  readonly runtime: CoreRuntime;
  readonly context: AdministrationContext;
  readonly cache: RoleCatalogueCache;
  /** The Platform's check that new grants name Projects and services that exist. */
  readonly validateGrantScopes?: ((scopes: ReadonlyArray<NonNullable<ZelavisPrincipalGrant["scope"]>>) => Effect.Effect<boolean>) | undefined;
}

export function defineRoleRoutes(options: RoleRoutesOptions): ReadonlyArray<ZelavisServerRoute> {
  const { runtime, context: administration, cache } = options;
  const platform = administration.authority === "platform";
  const scope = platform ? { type: "system" as const }
    : administration.projectId === undefined ? undefined : { type: "project" as const, projectId: administration.projectId };
  const managePermission = platform ? "system.roles.manage" : "project.users.manage";
  // Reading the catalogue is open to whoever manages roles or users here: assigning roles needs to see them.
  const readPermissions = platform ? ["system.roles.manage", "system.users.manage"] : ["project.users.manage"];
  const writeAccess: ZelavisAccessRequirement = { permissions: [managePermission], ...(scope === undefined ? {} : { scope }) };
  const readAccess: ZelavisAccessRequirement = platform ? { authenticated: true } : writeAccess;

  const actorFor = Effect.fn("auth.roles.actor")(function* (tx: Parameters<typeof resolveActor>[0], principal: ZelavisPrincipal | undefined, permissions: ReadonlyArray<string>) {
    for (const permission of permissions) {
      const actor = yield* resolveActor(tx, principal, administration, permission);
      if (actor !== null && principalHasPermission(actor, permission, scope)) return actor;
    }
    return null;
  });

  const answer = (status: number) => (change: RoleChange): ZelavisRouteResponse =>
    change.ok ? { status, headers: noStore, body: change.catalogue } : roleRefused(change);

  /** The Gateway's proof for a Platform principal in an App: undefined when none was sent, null when it does not hold. */
  const gatewayProof = (principal: ZelavisPrincipal | undefined) =>
    principal === undefined ? undefined : projectAccountAccessProof(principal);

  const route = (operation: RoleOperation, run: (context: ZelavisRouteContext) => Effect.Effect<ZelavisRouteResponse, AuthFailure>): ZelavisServerRoute => ({
    id: `auth.roles.${operation.action}`,
    method: operation.method,
    path: operation.path,
    access: operation.action === "list" ? readAccess : writeAccess,
    ...roleOperationSpec(operation),
    handler: (context) => respond(run(context)),
  });

  const unavailable = (read: CatalogueRead) => Effect.as(logUnreadable(read), roleRefused({ code: "roles_unavailable" }));

  /** Run a change; clear the catalogue copy once it returned, committed or not. */
  const change = <A, E>(effect: Effect.Effect<A, E>) => Effect.ensuring(effect, Effect.sync(cache.invalidate));

  const [list, create, update, remove] = roleOperations;
  return [
    route(list, (context) => Effect.gen(function* () {
      const read = yield* runtime.query(callOf(context), (tx) => Effect.gen(function* () {
        if ((yield* actorFor(tx, context.principal, readPermissions)) === null) return null;
        return yield* readCatalogue(tx);
      }));
      if (read === null) return roleRefused({ code: "account_access_forbidden" });
      if (read.unreadable.length > 0) return yield* unavailable(read);
      return answer(200)({ ok: true, catalogue: catalogueView(read) });
    })),

    ...[create, update].map((operation) => route(operation, (context) => Effect.gen(function* () {
      const input = decodeRoleInput(context.body);
      if (input === undefined) return roleRefused({ code: "invalid_role" });
      const roleId = operation.action === "update" ? context.params.roleId ?? "" : input.id;
      if (operation.action === "update" && roleId !== input.id) return roleRefused({ code: "invalid_role", message: "The role id in the body must match the path." });
      if (platform && options.validateGrantScopes !== undefined && input.grants.length > 0 &&
          !(yield* options.validateGrantScopes(input.grants.map(({ scope: grantScope }) => grantScope)))) {
        return roleRefused({ code: "invalid_role", message: "Role grants must name existing Projects or installed services." });
      }
      const call = callOf(context);
      const proof = gatewayProof(context.principal);
      let proved: ReadonlyArray<string> | undefined;
      if (proof !== undefined) {
        if (proof.digest === undefined || platform) return roleRefused({ code: "account_access_forbidden" });
        const read = yield* runtime.query(call, (tx) => readCatalogue(tx));
        if (read.unreadable.length > 0) return yield* unavailable(read);
        const names = roleContentPermissions(input, read.roles.find((role) => role.id === roleId));
        const path = operation.action === "update" ? `/roles/${roleId}` : "/roles";
        if ((yield* roleGatewayDigest(operation.method, path, input, names)) !== proof.digest) return roleRefused({ code: "account_access_forbidden" });
        proved = names;
      }
      const result = yield* change(runtime.mutation(call, (tx) => Effect.gen(function* () {
        const actor = yield* actorFor(tx, context.principal, [managePermission]);
        if (actor === null) return { ok: false, code: "account_access_forbidden" } as const;
        const args = { actor, context: administration, input, provedProjectPermissions: proved };
        return operation.action === "create" ? yield* createRole(tx, args) : yield* updateRole(tx, { ...args, roleId });
      })));
      return answer(operation.status)(result);
    }))),

    route(remove, (context) => Effect.gen(function* () {
      const roleId = context.params.roleId ?? "";
      const expectedRevision = revisionOf(context.query.get("revision"));
      if (expectedRevision === undefined) return roleRefused({ code: "invalid_role", message: "Name the catalogue revision: ?revision=N." });
      const proof = gatewayProof(context.principal);
      if (proof !== undefined && (proof.digest === undefined || platform ||
          (yield* roleGatewayDigest("DELETE", `/roles/${roleId}`, expectedRevision, [])) !== proof.digest)) {
        return roleRefused({ code: "account_access_forbidden" });
      }
      const result = yield* change(runtime.mutation(callOf(context), (tx) => Effect.gen(function* () {
        const actor = yield* actorFor(tx, context.principal, [managePermission]);
        if (actor === null) return { ok: false, code: "account_access_forbidden" } as const;
        return yield* deleteRole(tx, { actor, roleId, expectedRevision });
      })));
      return answer(remove.status)(result);
    })),
  ];
}
