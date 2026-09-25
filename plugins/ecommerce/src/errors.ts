/**
 * What ecommerce can fail with, in the error channel.
 *
 * These were `throw new TypeError(...)` and `throw new Error(...)`, which a
 * caller could only discover by reading the implementation and could only
 * handle by catching everything. As tagged errors they are part of each
 * operation's type, so a caller is told which failures exist and the compiler
 * notices when a new one appears.
 */
import { Schema } from "effect";

/** A caller's input cannot produce the thing they asked for. */
export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  /** The field at fault, so a route can answer with something specific. */
  field: Schema.String,
  message: Schema.String,
}) {}

/** Something was addressed by id and is not there. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  /** What kind of thing: `order`, `subscription`, `product`. */
  resource: Schema.String,
  id: Schema.String,
}) {}

/** A payment provider was named that nothing registered. */
export class UnknownProvider extends Schema.TaggedError<UnknownProvider>()("UnknownProvider", {
  provider: Schema.String,
}) {}

/**
 * A provider is registered but does not implement what was asked of it.
 *
 * Distinct from `UnknownProvider`: the caller named something real, and the
 * gap is in the provider's capabilities rather than in the name.
 */
export class UnsupportedOperation extends Schema.TaggedError<UnsupportedOperation>()(
  "UnsupportedOperation",
  {
    provider: Schema.String,
    operation: Schema.String,
  },
) {}

/** Storage refused or failed, with whatever the driver said underneath. */
export class StorageFailure extends Schema.TaggedError<StorageFailure>()("StorageFailure", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/**
 * A payment provider rejected or threw.
 *
 * Separate from `StorageFailure` because the remedy differs: a provider
 * failure is usually the customer's or the gateway's, and is worth showing,
 * where a storage failure is ours and is worth alerting on.
 */
export class ProviderFailure extends Schema.TaggedError<ProviderFailure>()("ProviderFailure", {
  provider: Schema.String,
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** Every failure this domain raises, for a caller that wants to name them all. */
export type EcommerceError =
  | InvalidInput
  | NotFound
  | UnknownProvider
  | UnsupportedOperation
  | ProviderFailure
  | StorageFailure;
