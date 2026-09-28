/**
 * What installing, uninstalling and activating a service can fail with.
 *
 * Every one of these arrived as a thrown value that the route collapsed into
 * one 400. A caller could not tell "this installation does not allow that
 * source" from "the registry is busy, try again" — different remedies, the
 * same answer. As tagged errors they are part of the flow's type, so the
 * compiler notices a new failure and the route maps each to what it means.
 */
import { Schema } from "effect";

/** The request could not be read as a service registration. */
export class InvalidRegistration extends Schema.TaggedError<InvalidRegistration>()(
  "InvalidRegistration",
  { field: Schema.String, message: Schema.String },
) {}

/**
 * The source was refused before anything was fetched.
 *
 * Acquisition is default-deny, so this is the ordinary answer for an
 * installation that has configured no remote sources — not an error in the
 * request.
 */
export class SourceRefused extends Schema.TaggedError<SourceRefused>()("SourceRefused", {
  reference: Schema.String,
  reason: Schema.String,
}) {}

/** The bytes were fetched and did not match the digest that was promised. */
export class IntegrityMismatch extends Schema.TaggedError<IntegrityMismatch>()(
  "IntegrityMismatch",
  { reference: Schema.String, expected: Schema.String, received: Schema.String },
) {}

/** Fetching failed: the network, the registry, or the forge. */
export class AcquisitionFailed extends Schema.TaggedError<AcquisitionFailed>()(
  "AcquisitionFailed",
  { reference: Schema.String, cause: Schema.Defect() },
) {}

/** The package arrived but is not a service this Platform can mount. */
export class UnusablePackage extends Schema.TaggedError<UnusablePackage>()("UnusablePackage", {
  reference: Schema.String,
  reason: Schema.String,
}) {}

/** Writing the package to disk failed. */
export class MaterializationFailed extends Schema.TaggedError<MaterializationFailed>()(
  "MaterializationFailed",
  { reference: Schema.String, cause: Schema.Defect() },
) {}

/**
 * The registry changed under every attempt.
 *
 * A retry answer rather than a refusal: the caller's request was fine and
 * somebody else's landed first, repeatedly.
 */
export class RegistryContended extends Schema.TaggedError<RegistryContended>()(
  "RegistryContended",
  { attempts: Schema.Int },
) {}

/** Reading or writing the registry itself failed. */
export class RegistryUnavailable extends Schema.TaggedError<RegistryUnavailable>()(
  "RegistryUnavailable",
  { cause: Schema.Defect() },
) {}

/**
 * The registry was updated and the runtime refused to mount the result.
 *
 * Carries what the registry looked like before, because recovering from this
 * means putting that back: a registry saying "installed" over a runtime that
 * never mounted it is the split state this whole flow exists to avoid.
 */
export class ActivationFailed extends Schema.TaggedError<ActivationFailed>()("ActivationFailed", {
  serviceName: Schema.String,
  message: Schema.String,
}) {}

export type ServiceLifecycleError =
  | InvalidRegistration
  | SourceRefused
  | IntegrityMismatch
  | AcquisitionFailed
  | UnusablePackage
  | MaterializationFailed
  | RegistryContended
  | RegistryUnavailable
  | ActivationFailed;
