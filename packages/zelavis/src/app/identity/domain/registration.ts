import { Schema } from "effect";

export const REGISTRATION_SLOT_LIMIT = 8;
export const REGISTRATION_ATTEMPT_LIMIT = 60;
export const REGISTRATION_WINDOW_MS = 60_000;

export const RegistrationSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
  revision: Schema.Natural,
});
export type RegistrationSettings = typeof RegistrationSettingsSchema.Type;

export const SetRegistrationSettingsInputSchema = Schema.Struct({
  enabled: Schema.Boolean,
  expectedRevision: Schema.Natural,
});
export type SetRegistrationSettingsInput = typeof SetRegistrationSettingsInputSchema.Type;

export const RegistrationStatusSchema = Schema.Struct({
  enabled: Schema.Boolean,
  providers: Schema.Array(Schema.String),
});
export type RegistrationStatus = typeof RegistrationStatusSchema.Type;

const enrollmentId = Schema.String.check(
  Schema.isBetweenLength(1, 96),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
);
const EnrollmentSlotSchema = Schema.Struct({
  accountId: enrollmentId,
  credentialId: enrollmentId,
  policyRevision: Schema.Natural,
  phase: Schema.Literals(["reserved", "committed"]),
});
export type EnrollmentSlot = typeof EnrollmentSlotSchema.Type;

export const RegistrationControlSchema = Schema.Struct({
  ...RegistrationSettingsSchema.fields,
  id: Schema.Literal("registration"),
  schemaVersion: Schema.Literal(1),
  windowStartMs: Schema.Natural.check(Schema.isMultipleOf(REGISTRATION_WINDOW_MS)),
  windowAttempts: Schema.Natural.check(Schema.isLessThanOrEqualTo(REGISTRATION_ATTEMPT_LIMIT)),
  slots: Schema.Array(EnrollmentSlotSchema).check(Schema.isMaxLength(REGISTRATION_SLOT_LIMIT)),
}).check(Schema.makeFilter((control) => {
  const ids = new Set<string>();
  for (const slot of control.slots) {
    if (
      slot.policyRevision > control.revision ||
      ids.has(slot.accountId) ||
      ids.has(slot.credentialId) ||
      slot.accountId === slot.credentialId
    ) return "Registration slots must have unique IDs and valid policy revisions.";
    ids.add(slot.accountId);
    ids.add(slot.credentialId);
  }
  return undefined;
}));
export type RegistrationControl = typeof RegistrationControlSchema.Type;

export const decodeRegistrationControl = Schema.decodeUnknownSync(
  RegistrationControlSchema,
  { onExcessProperty: "error" },
);
export const decodeSetRegistrationSettingsInput = Schema.decodeUnknownSync(
  SetRegistrationSettingsInputSchema,
  { onExcessProperty: "error" },
);

export interface RegistrationServiceOptions {
  readonly authority: "platform" | "project";
  readonly initiallyEnabled: boolean;
  readonly enrollmentReady: () => Promise<boolean>;
  readonly now: () => Date;
}

export const REGISTRATION_SETTINGS_BODY_BYTES = 1024;

export const registrationSettingsJsonSchema = Schema.toJsonSchemaDocument(RegistrationSettingsSchema).schema;
export const registrationStatusJsonSchema = Schema.toJsonSchemaDocument(RegistrationStatusSchema).schema;
export const registrationSettingsInputJsonSchema = Schema.toJsonSchemaDocument(
  SetRegistrationSettingsInputSchema,
  { onExcessProperty: "error" },
).schema;
