/**
 * The role catalogue (Zelavis-own): what a role is, and reading a runtime's
 * roles inside a transaction. Every decision that depends on a role (an
 * access edit, an invitation, a role change, rebuilding an administrator)
 * reads the catalogue through the transaction that acts on it, so the
 * decision and its write see the same roles. Authentication reads the
 * in-process copy in `cache.ts` instead.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import type { TransactionTooLarge } from "../../db/errors.js";
import { GrantSchema, PermissionSchema, RoleIdSchema } from "../access/access.js";
import type { AuthTxBase } from "../runtime/index.js";
import type { RoleCatalogue } from "./expand.js";
import { rolesTables } from "./tables.js";

/** Roles one runtime may define. */
export const ROLE_LIMIT = 50;
/** Permissions, grants and Project permissions one role may hold together. */
export const ROLE_ENTRY_LIMIT = 100;
export const ROLE_BODY_BYTES = 64 * 1024;

const TitleSchema = Schema.String.check(Schema.isBetweenLength(1, 80), Schema.isPattern(/^[^\x00-\x1f\x7f]*$/u));
const DescriptionSchema = Schema.String.check(Schema.isMaxLength(500));
const contentFields = {
  title: TitleSchema,
  description: Schema.optional(DescriptionSchema),
  permissions: Schema.Array(PermissionSchema).check(Schema.isMaxLength(ROLE_ENTRY_LIMIT)),
  grants: Schema.Array(GrantSchema).check(Schema.isMaxLength(ROLE_ENTRY_LIMIT)),
  projectPermissions: Schema.Array(PermissionSchema).check(Schema.isMaxLength(ROLE_ENTRY_LIMIT)),
};

export const RoleDefinitionInputSchema = Schema.Struct({
  id: RoleIdSchema,
  ...contentFields,
  /** The catalogue revision the change was made against. */
  expectedRevision: Schema.Natural,
});
export type RoleDefinitionInput = typeof RoleDefinitionInputSchema.Type;

export const RoleDefinitionSchema = Schema.Struct({
  id: RoleIdSchema,
  ...contentFields,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type RoleDefinition = typeof RoleDefinitionSchema.Type;

export const RoleCatalogueViewSchema = Schema.Struct({
  revision: Schema.Natural,
  roles: Schema.Array(RoleDefinitionSchema),
});
export type RoleCatalogueView = typeof RoleCatalogueViewSchema.Type;

const strict = { onExcessProperty: "error" } as const;
export const decodeRoleDefinitionInput = Schema.decodeUnknownSync(RoleDefinitionInputSchema, strict);
export const roleDefinitionInputJsonSchema = Schema.toJsonSchemaDocument(RoleDefinitionInputSchema, strict).schema;
export const roleCatalogueJsonSchema = Schema.toJsonSchemaDocument(RoleCatalogueViewSchema).schema;
export const decodeRoleCatalogueView = Schema.decodeUnknownSync(RoleCatalogueViewSchema);

/** A role's content as a row holds it. */
export const StoredRoleSchema = Schema.Struct({
  ...contentFields,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
});
export type StoredRole = typeof StoredRoleSchema.Type;

export interface CatalogueRole extends StoredRole {
  readonly id: string;
  readonly rowId: string;
}

export interface CatalogueRead {
  readonly revision: number;
  readonly revisionRowId: string | undefined;
  /** In role id order. */
  readonly roles: ReadonlyArray<CatalogueRole>;
  /** Rows that do not decode: they grant nothing, and role administration refuses until they are repaired. */
  readonly unreadable: ReadonlyArray<string>;
}

const decodeStored = Schema.decodeUnknownExit(StoredRoleSchema, strict);
const isRoleId = Schema.is(RoleIdSchema);

export const readCatalogue = Effect.fn("auth.roles.readCatalogue")(function* (tx: AuthTxBase): Effect.fn.Return<CatalogueRead, TransactionTooLarge> {
  const revisionRow = yield* tx.db.query(rolesTables.catalogue).unique();
  const rows = yield* tx.db.query(rolesTables.roles).withIndex("by_roleId").take(ROLE_LIMIT + 1);
  const roles: CatalogueRole[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const decoded = decodeStored(row.definition);
    if (Exit.isFailure(decoded) || !isRoleId(row.roleId) || seen.has(row.roleId)) {
      unreadable.push(row._id);
      continue;
    }
    seen.add(row.roleId);
    roles.push({ ...decoded.value, id: row.roleId, rowId: row._id });
  }
  if (rows.length > ROLE_LIMIT) unreadable.push(...rows.slice(ROLE_LIMIT).map((row) => row._id));
  const revision = revisionRow?.revision ?? 0;
  const valid = Number.isSafeInteger(revision) && revision >= 0 && revision < Number.MAX_SAFE_INTEGER;
  if (!valid) unreadable.push(revisionRow?._id ?? "catalogue");
  return { revision: valid ? revision : 0, revisionRowId: revisionRow?._id, roles, unreadable };
});

/** One line per row that does not decode, naming the collection and row and nothing of its content. */
export const logUnreadable = (read: CatalogueRead): Effect.Effect<void> =>
  Effect.forEach(read.unreadable, (id) => Effect.logWarning(`${rolesTables.roles.collection} row ${id} does not decode; it grants nothing.`), { discard: true });

export function catalogueMap(read: CatalogueRead): RoleCatalogue {
  return new Map(read.roles.map((role) => [role.id, role]));
}

/** The catalogue as a transaction reads it, by id; unreadable rows are absent. */
export const readRoleCatalogue = (tx: AuthTxBase): Effect.Effect<RoleCatalogue, TransactionTooLarge> =>
  Effect.map(readCatalogue(tx), catalogueMap);

export function roleView(role: CatalogueRole): RoleDefinition {
  return {
    id: role.id,
    title: role.title,
    ...(role.description === undefined ? {} : { description: role.description }),
    permissions: [...role.permissions],
    grants: role.grants.map((grant) => ({ permission: grant.permission, scope: { ...grant.scope } })),
    projectPermissions: [...role.projectPermissions],
    createdAt: new Date(role.createdAt).toISOString(),
    updatedAt: new Date(role.updatedAt).toISOString(),
  };
}

export function catalogueView(read: CatalogueRead): RoleCatalogueView {
  return { revision: read.revision, roles: read.roles.map(roleView) };
}
