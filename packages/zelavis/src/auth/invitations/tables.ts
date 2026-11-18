import * as Schema from "effect/Schema";
import { EmailAddressSchema } from "../../app/email/contracts.js";
import { DelegatedAccessSchema } from "../access/access.js";
import type { RowOf } from "../core/tables.js";
import { defineTable, defineTables } from "../runtime/index.js";

export const INVITATION_LIMIT = 500;
export const INVITATION_ID = /^[0-9a-f]{32}$/u;
export const INVITATION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

const InvitationStatus = Schema.Literals(["pending", "accepted", "revoked"]);

export const CreateInvitationInputSchema = Schema.Struct({
  email: EmailAddressSchema,
  access: DelegatedAccessSchema,
});
export type CreateInvitationInput = typeof CreateInvitationInputSchema.Type;

export const AcceptInvitationInputSchema = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(INVITATION_TOKEN)),
  username: Schema.optional(Schema.String),
  password: Schema.optional(Schema.String),
});
export type AcceptInvitationInput = typeof AcceptInvitationInputSchema.Type;

export const PublicInvitationSchema = Schema.Struct({
  id: Schema.String,
  email: EmailAddressSchema,
  access: DelegatedAccessSchema,
  status: InvitationStatus,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  acceptedAccountId: Schema.optional(Schema.String),
});
export type PublicInvitation = typeof PublicInvitationSchema.Type;

export const InvitationPageSchema = Schema.Struct({
  invitations: Schema.Array(PublicInvitationSchema),
  next: Schema.optional(Schema.String),
});
export type InvitationPage = typeof InvitationPageSchema.Type;

export interface InvitationListOptions {
  readonly limit?: number;
  readonly after?: string;
}

export const invitationsTables = defineTables("invitations", {
  invitations: defineTable({
    email: EmailAddressSchema,
    normalizedEmail: EmailAddressSchema,
    access: DelegatedAccessSchema,
    invitedBy: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("account"), accountId: Schema.String }),
      Schema.Struct({ kind: Schema.Literal("gateway"), principalId: Schema.String }),
    ]),
    tokenHash: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
    status: InvitationStatus,
    acceptedAccountId: Schema.optional(Schema.String),
    expiresAt: Schema.Natural,
  }).index("by_tokenHash", ["tokenHash"], { unique: true })
    .index("by_status", ["status", "_id"])
    .index("by_created", ["_creationTime", "_id"]),
  counter: defineTable({ pending: Schema.Natural }),
});

export type Invitation = RowOf<typeof invitationsTables.invitations>;
