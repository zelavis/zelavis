import { Effect, Schema } from "effect";
import { encode as encodeHex } from "effect/encoding/Hex";
import type { ZelavisAccessScope, ZelavisPrincipal, ZelavisPrincipalGrant } from "../../../core/index.js";
import { integration } from "../../../core/runtime/effect-boundary.js";

export const ACCOUNT_ACCESS_LIMIT = 100;
export const ACCOUNT_ACCESS_BODY_BYTES = 32 * 1024;

const PermissionSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
  Schema.isPattern(/^[a-z][a-z0-9.\-:/]*$/u),
);
const ProjectIdSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
);
const ServiceNameSchema = Schema.String.check(
  Schema.isBetweenLength(1, 128),
  Schema.isPattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
);
const RoleSchema = Schema.Literals(["customer", "operator", "reseller", "user"]);
const ScopeSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("system") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: ProjectIdSchema }),
  Schema.Struct({ type: Schema.Literal("service"), serviceName: ServiceNameSchema }),
]);
const GrantSchema = Schema.Struct({
  permission: PermissionSchema,
  scope: ScopeSchema,
});

export const SetAccountAccessInputSchema = Schema.Struct({
  expectedRevision: Schema.Natural,
  role: RoleSchema,
  permissions: Schema.Array(PermissionSchema).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT)),
  grants: Schema.Array(GrantSchema).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT)),
}).check(Schema.makeFilter(({ permissions, grants }) =>
  permissions.length + grants.length <= ACCOUNT_ACCESS_LIMIT ||
    `Access may contain at most ${ACCOUNT_ACCESS_LIMIT} permissions and grants combined.`,
));
const AccountAccessResultSchema = Schema.Struct({
  accountId: Schema.String,
  accessRevision: Schema.Natural,
  role: RoleSchema,
  permissions: SetAccountAccessInputSchema.fields.permissions,
  grants: SetAccountAccessInputSchema.fields.grants,
});

export type HumanAccountRole = typeof RoleSchema.Type;
export type ConcreteAccountGrant = typeof GrantSchema.Type;
export type SetAccountAccessInput = typeof SetAccountAccessInputSchema.Type;
export type AccountAccessResult = typeof AccountAccessResultSchema.Type;

const strict = { onExcessProperty: "error" } as const;
export const decodeSetAccountAccessInput = Schema.decodeUnknownSync(SetAccountAccessInputSchema, strict);
export const accountAccessInputJsonSchema = Schema.toJsonSchemaDocument(SetAccountAccessInputSchema, strict).schema;
export const accountAccessResultJsonSchema = Schema.toJsonSchemaDocument(AccountAccessResultSchema, strict).schema;
const isAccountAccessPermission = Schema.is(PermissionSchema);

const StoredPermissionSchema = Schema.Union([PermissionSchema, Schema.Literal("*")]);
const ProjectAccountAuthoritySchema = Schema.Struct({
  id: Schema.String,
  accessRevision: Schema.Natural,
  permissions: Schema.optional(Schema.Array(StoredPermissionSchema).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT))),
  grants: Schema.optional(Schema.Array(Schema.Struct({
    permission: StoredPermissionSchema,
    scope: ScopeSchema,
  })).check(Schema.isMaxLength(ACCOUNT_ACCESS_LIMIT))),
});
export const decodeProjectAccountAuthority = Schema.decodeUnknownSync(Schema.Array(ProjectAccountAuthoritySchema)
  .check(Schema.isMaxLength(1)));

const projectAccessProofs = new WeakMap<ZelavisPrincipal, { readonly digest?: string }>();
export const bindProjectAccountAccessProof = (principal: ZelavisPrincipal, digest?: string): void => {
  projectAccessProofs.set(principal, { digest });
};
export const projectAccountAccessProof = (principal: ZelavisPrincipal) =>
  projectAccessProofs.get(principal);

export function projectAccountAccessPermissions(
  projectId: string,
  current: { readonly permissions?: readonly string[]; readonly grants?: readonly ZelavisPrincipalGrant[] },
  input: SetAccountAccessInput,
): readonly string[] | undefined {
  const permissions = [...(current.permissions ?? []), ...input.grants.map(({ permission }) => permission)];
  for (const { permission, scope } of current.grants ?? []) {
    if (scope?.type !== "project" || scope.projectId !== projectId || scope.projectIdParam !== undefined) return undefined;
    permissions.push(permission);
  }
  // Existing account creation bounds permissions and grants separately.
  return permissions.length <= ACCOUNT_ACCESS_LIMIT * 3 && permissions.every((permission) => permission === "*" || isAccountAccessPermission(permission))
    ? [...new Set(permissions)].sort()
    : undefined;
}

/** The Gateway signs the exact permission set without placing the current and requested names in request headers. */
export function projectAccountAccessDigest(accountId: string, input: SetAccountAccessInput, permissions: readonly string[]) {
  const bytes = new TextEncoder().encode(JSON.stringify([accountId, normalizeAccountAccess(input), permissions]));
  return integration(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) => encodeHex(new Uint8Array(digest))),
  );
}

export function isConcreteScope(scope: ZelavisAccessScope): boolean {
  switch (scope.type) {
    case "system": return true;
    case "project": return !!scope.projectId && scope.projectIdParam === undefined;
    case "service": return !!scope.serviceName && scope.serviceNameParam === undefined;
  }
}

export function accountGrantKey({ permission, scope }: ZelavisPrincipalGrant): string {
  return JSON.stringify([
    permission,
    scope?.type,
    scope?.type === "project" ? scope.projectId : scope?.type === "service" ? scope.serviceName : undefined,
  ]);
}

export function normalizeAccountAccess(input: SetAccountAccessInput): SetAccountAccessInput {
  const grants = new Map(input.grants.map((grant) => [
    accountGrantKey(grant),
    { permission: grant.permission, scope: { ...grant.scope } },
  ]));
  return {
    expectedRevision: input.expectedRevision,
    role: input.role,
    permissions: [...new Set(input.permissions)].sort(),
    grants: [...grants.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, grant]) => grant),
  };
}
