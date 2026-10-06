export type CapacityErrorCode =
  | "invalid-request"
  | "no-machine-class"
  | "node-cap-reached"
  | "not-managed"
  | "cloud"
  | "state";

/**
 * Every failure the capacity provider reports to its caller. A plain Error with
 * a stable `code`, so it crosses the Promise-based `CapacityProvider` contract
 * without leaking Effect internals, and callers can branch on `code`.
 */
export class CapacityError extends Error {
  readonly code: CapacityErrorCode;

  constructor(code: CapacityErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CapacityError";
    this.code = code;
  }
}
