/**
 * Custom roles (Zelavis-own): define, change and delete the roles of one
 * runtime's catalogue.
 *
 * Every change is one Auth transaction: it reads the catalogue, checks that
 * `expectedRevision` is still its revision, checks the actor's authority, and
 * writes the role row and the raised revision. The revision makes concurrent
 * changes serial: of several changes made against one revision, one commits
 * and the others are refused with `role_revision_conflict`.
 *
 * An actor can define or change a role only when it could give the role's
 * whole content directly: its permissions, its grants and, on the Platform,
 * its Project permissions held runtime-wide, since the role can be assigned
 * for any Project later. A change must also be one the actor could have
 * given before it (the content it replaces), so nobody edits a role holding
 * more than they do. Deleting a role takes authority away and needs only the
 * right to manage roles. Members are not touched: their next request is
 * expanded from the new catalogue (`cache.ts`).
 */
import * as Effect from "effect/Effect";
import type { ZelavisPrincipal } from "../../core/index.js";
import type { TransactionTooLarge } from "../../db/errors.js";
import { RESERVED_ROLE_IDS, accountGrantKey } from "../access/access.js";
import { type AdministrationContext, canDelegateAccess } from "../access/delegation.js";
import type { AuthTxBase } from "../runtime/index.js";
import { recordSecurityEvent } from "../security/events.js";
import {
  type CatalogueRead,
  type CatalogueRole,
  type RoleCatalogueView,
  type RoleDefinitionInput,
  ROLE_ENTRY_LIMIT,
  ROLE_LIMIT,
  type StoredRole,
  catalogueView,
  readCatalogue,
} from "./catalogue.js";
import type { RoleContent } from "./expand.js";
import { rolesTables } from "./tables.js";

export type RoleRefusalCode =
  | "invalid_role"
  | "role_exists"
  | "role_not_found"
  | "role_revision_conflict"
  | "role_limit"
  | "roles_unavailable"
  | "account_access_forbidden";

export interface RoleRefusal {
  readonly ok: false;
  readonly code: RoleRefusalCode;
  readonly message?: string;
}

const refuse = (code: RoleRefusalCode, message?: string): RoleRefusal => ({ ok: false, code, ...(message === undefined ? {} : { message }) });

export type RoleChange = { readonly ok: true; readonly catalogue: RoleCatalogueView } | RoleRefusal;

/** Why `input` cannot be a role here, or undefined when it can. */
export function roleProblem(context: AdministrationContext, input: RoleDefinitionInput): string | undefined {
  if (RESERVED_ROLE_IDS.has(input.id)) return `${input.id} is a built-in role.`;
  if (input.permissions.length + input.grants.length + input.projectPermissions.length > ROLE_ENTRY_LIMIT) {
    return `A role may hold at most ${ROLE_ENTRY_LIMIT} permissions, grants and Project permissions together.`;
  }
  if (context.authority === "project" && (input.grants.length > 0 || input.projectPermissions.length > 0)) {
    return "An App role holds permissions only; they apply to the App's own Project.";
  }
  return undefined;
}

/** A role's content with duplicates removed and in a stable order. */
export function normalizeRoleContent(input: RoleDefinitionInput): Omit<StoredRole, "createdAt" | "updatedAt"> {
  const grants = new Map(input.grants.map((grant) => [accountGrantKey(grant), { permission: grant.permission, scope: { ...grant.scope } }]));
  return {
    title: input.title,
    ...(input.description === undefined || input.description === "" ? {} : { description: input.description }),
    permissions: [...new Set(input.permissions)].sort(),
    grants: [...grants.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, grant]) => grant),
    projectPermissions: [...new Set(input.projectPermissions)].sort(),
  };
}

/**
 * The permission names a role's content hands out: what the Gateway proves
 * for an App role change made by a Platform principal.
 */
export const roleContentPermissions = (...contents: ReadonlyArray<RoleContent | undefined>): ReadonlyArray<string> =>
  [...new Set(contents.flatMap((content) => content === undefined ? [] : [
    ...content.permissions, ...content.grants.map(({ permission }) => permission), ...content.projectPermissions,
  ]))].sort();

/** Whether `actor` could give a role's whole content directly (see the module comment). */
export function canDelegateRoleContent(
  actor: ZelavisPrincipal,
  context: AdministrationContext,
  content: RoleContent,
  provedProjectPermissions?: ReadonlyArray<string>,
): boolean {
  return context.authority === "platform"
    ? canDelegateAccess(actor, context, { permissions: [...content.permissions, ...content.projectPermissions], grants: content.grants })
    : canDelegateAccess(actor, context, { permissions: content.permissions }, provedProjectPermissions);
}

export const listRoles = Effect.fn("auth.roles.list")(function* (tx: AuthTxBase): Effect.fn.Return<RoleChange, TransactionTooLarge> {
  const read = yield* readCatalogue(tx);
  return read.unreadable.length > 0 ? refuse("roles_unavailable") : { ok: true, catalogue: catalogueView(read) } as const;
});

/** The catalogue `read` with `role` in place of the role of its id, or without that role when `role` is a bare id. */
const after = (read: CatalogueRead, revision: number, role: CatalogueRole | string): CatalogueRead => {
  const id = typeof role === "string" ? role : role.id;
  const roles = read.roles.filter((existing) => existing.id !== id);
  if (typeof role !== "string") roles.push(role);
  roles.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { ...read, revision, roles };
};

/** Check the revision and raise it, in the transaction that writes the change. */
const raiseRevision = Effect.fn("auth.roles.raiseRevision")(function* (tx: AuthTxBase, read: CatalogueRead) {
  const revision = read.revision + 1;
  if (read.revisionRowId === undefined) yield* tx.db.insert(rolesTables.catalogue, { revision });
  else yield* tx.db.patch(rolesTables.catalogue, read.revisionRowId, { revision });
  return revision;
});

interface WriteArgs {
  readonly actor: ZelavisPrincipal;
  readonly context: AdministrationContext;
  readonly input: RoleDefinitionInput;
  /** Permission names the Gateway proved for a Platform principal acting in an App. */
  readonly provedProjectPermissions?: ReadonlyArray<string> | undefined;
}

const opening = Effect.fn("auth.roles.open")(function* (tx: AuthTxBase, expectedRevision: number) {
  const read = yield* readCatalogue(tx);
  if (read.unreadable.length > 0) return refuse("roles_unavailable");
  if (read.revision !== expectedRevision) return refuse("role_revision_conflict");
  return read;
});

export const createRole = Effect.fn("auth.roles.create")(function* (tx: AuthTxBase, args: WriteArgs): Effect.fn.Return<RoleChange, TransactionTooLarge> {
  const problem = roleProblem(args.context, args.input);
  if (problem !== undefined) return refuse("invalid_role", problem);
  const read = yield* opening(tx, args.input.expectedRevision);
  if ("ok" in read) return read;
  if (read.roles.some((role) => role.id === args.input.id)) return refuse("role_exists");
  if (read.roles.length >= ROLE_LIMIT) return refuse("role_limit");
  const content = normalizeRoleContent(args.input);
  if (!canDelegateRoleContent(args.actor, args.context, content, args.provedProjectPermissions)) return refuse("account_access_forbidden");
  const stored: StoredRole = { ...content, createdAt: tx.now, updatedAt: tx.now };
  const rowId = yield* tx.db.insert(rolesTables.roles, { roleId: args.input.id, definition: stored });
  const revision = yield* raiseRevision(tx, read);
  yield* recordSecurityEvent(tx, { kind: "role.created", actorId: args.actor.id, detail: { role: args.input.id, revision } });
  return { ok: true, catalogue: catalogueView(after(read, revision, { ...stored, id: args.input.id, rowId })) } as const;
});

export const updateRole = Effect.fn("auth.roles.update")(function* (tx: AuthTxBase, args: WriteArgs & { readonly roleId: string }): Effect.fn.Return<RoleChange, TransactionTooLarge> {
  if (args.roleId !== args.input.id) return refuse("invalid_role", "The role id in the body must match the path.");
  const problem = roleProblem(args.context, args.input);
  if (problem !== undefined) return refuse("invalid_role", problem);
  const read = yield* opening(tx, args.input.expectedRevision);
  if ("ok" in read) return read;
  const current = read.roles.find((role) => role.id === args.roleId);
  if (current === undefined) return refuse("role_not_found");
  const content = normalizeRoleContent(args.input);
  if (!canDelegateRoleContent(args.actor, args.context, current, args.provedProjectPermissions) ||
      !canDelegateRoleContent(args.actor, args.context, content, args.provedProjectPermissions)) {
    return refuse("account_access_forbidden");
  }
  const stored: StoredRole = { ...content, createdAt: current.createdAt, updatedAt: tx.now };
  yield* tx.db.replace(rolesTables.roles, current.rowId, { roleId: current.id, definition: stored });
  const revision = yield* raiseRevision(tx, read);
  yield* recordSecurityEvent(tx, { kind: "role.changed", actorId: args.actor.id, detail: { role: current.id, revision } });
  return { ok: true, catalogue: catalogueView(after(read, revision, { ...stored, id: current.id, rowId: current.rowId })) } as const;
});

export const deleteRole = Effect.fn("auth.roles.delete")(function* (
  tx: AuthTxBase,
  args: { readonly actor: ZelavisPrincipal; readonly roleId: string; readonly expectedRevision: number },
): Effect.fn.Return<RoleChange, TransactionTooLarge> {
  const read = yield* opening(tx, args.expectedRevision);
  if ("ok" in read) return read;
  const current = read.roles.find((role) => role.id === args.roleId);
  if (current === undefined) return refuse("role_not_found");
  yield* tx.db.delete(rolesTables.roles, current.rowId);
  const revision = yield* raiseRevision(tx, read);
  yield* recordSecurityEvent(tx, { kind: "role.deleted", actorId: args.actor.id, detail: { role: current.id, revision } });
  return { ok: true, catalogue: catalogueView(after(read, revision, current.id)) } as const;
});
