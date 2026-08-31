export interface ZelavisHostOperationArgumentDefinition {
  readonly required?: boolean;
  readonly pattern?: string;
  readonly maxLength?: number;
}

export interface ZelavisHostOperationManifest {
  readonly id: string;
  readonly version: string;
  readonly sha256: string;
  readonly arguments: Readonly<Record<string, ZelavisHostOperationArgumentDefinition>>;
}

export interface ZelavisHostOperationRequest {
  readonly operationId: string;
  readonly operation: string;
  readonly version: string;
  readonly artifactDigest: string;
  readonly authority: string;
  /** Declared non-secret argv values. Secrets require a future protected input channel. */
  readonly arguments: Readonly<Record<string, string>>;
  readonly deadline: string;
  readonly projectId?: string;
}

export interface ZelavisHostOperationResult {
  readonly operationId: string;
  readonly operation: string;
  readonly version: string;
  readonly status: "succeeded" | "failed";
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ZelavisHostOperationExecutor {
  execute(request: ZelavisHostOperationRequest): Promise<ZelavisHostOperationResult>;
}

export class ZelavisHostOperationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZelavisHostOperationValidationError";
  }
}

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^v?[1-9][0-9]*(?:\.[0-9]+){0,2}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{15,127}$/;

export function validateHostOperationRequestShape(
  request: ZelavisHostOperationRequest,
  now = Date.now(),
): ZelavisHostOperationRequest {
  if (!OPERATION_ID_PATTERN.test(request.operationId)) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request requires a stable 16-128 character operation id.",
    );
  }
  if (!ID_PATTERN.test(request.operation) || request.operation.length > 128) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request has an invalid operation name.",
    );
  }
  if (!VERSION_PATTERN.test(request.version) || !SHA256_PATTERN.test(request.artifactDigest)) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request has an invalid version or artifact digest.",
    );
  }
  if (!request.authority || request.authority.length > 16_384) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request requires a bounded authority envelope.",
    );
  }
  if (
    !request.arguments ||
    typeof request.arguments !== "object" ||
    Array.isArray(request.arguments) ||
    Object.values(request.arguments).some((value) => typeof value !== "string")
  ) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request arguments must be string values.",
    );
  }
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 15 * 60_000) {
    throw new ZelavisHostOperationValidationError(
      "Host operation deadline must be in the next 15 minutes.",
    );
  }
  return request;
}

export function validateHostOperationManifest(
  manifest: ZelavisHostOperationManifest,
): ZelavisHostOperationManifest {
  if (!ID_PATTERN.test(manifest.id) || manifest.id.length > 128) {
    throw new ZelavisHostOperationValidationError(
      "Host operation id must be a lowercase dotted slug.",
    );
  }
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new ZelavisHostOperationValidationError(
      "Host operation version must be an explicit numeric version.",
    );
  }
  if (!SHA256_PATTERN.test(manifest.sha256)) {
    throw new ZelavisHostOperationValidationError(
      "Host operation artifact digest must be a lowercase SHA-256 hex digest.",
    );
  }
  for (const [name, definition] of Object.entries(manifest.arguments)) {
    if (!ID_PATTERN.test(name) || name.length > 64) {
      throw new ZelavisHostOperationValidationError(
        `Host operation argument name "${name}" is invalid.`,
      );
    }
    if (
      definition.maxLength !== undefined &&
      (!Number.isInteger(definition.maxLength) ||
        definition.maxLength < 1 ||
        definition.maxLength > 16_384)
    ) {
      throw new ZelavisHostOperationValidationError(
        `Host operation argument "${name}" has an invalid maximum length.`,
      );
    }
    if (definition.pattern !== undefined) {
      try {
        new RegExp(definition.pattern, "u");
      } catch {
        throw new ZelavisHostOperationValidationError(
          `Host operation argument "${name}" has an invalid pattern.`,
        );
      }
    }
  }
  const argumentDefinitions = Object.fromEntries(
    Object.entries(manifest.arguments).map(([name, definition]) => [
      name,
      Object.freeze({ ...definition }),
    ]),
  );
  return Object.freeze({
    ...manifest,
    arguments: Object.freeze(argumentDefinitions),
  });
}

export function validateHostOperationRequest(
  request: ZelavisHostOperationRequest,
  manifest: ZelavisHostOperationManifest,
  now = Date.now(),
): ZelavisHostOperationRequest {
  validateHostOperationRequestShape(request, now);
  if (
    request.operation !== manifest.id ||
    request.version !== manifest.version ||
    request.artifactDigest !== manifest.sha256
  ) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request does not match the registered artifact manifest.",
    );
  }
  const supplied = Object.keys(request.arguments);
  if (supplied.some((name) => !(name in manifest.arguments))) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request contains an undeclared argument.",
    );
  }
  for (const [name, definition] of Object.entries(manifest.arguments)) {
    const value = request.arguments[name];
    if (definition.required && value === undefined) {
      throw new ZelavisHostOperationValidationError(
        `Host operation argument "${name}" is required.`,
      );
    }
    if (value === undefined) continue;
    if (value.length > (definition.maxLength ?? 1_024)) {
      throw new ZelavisHostOperationValidationError(
        `Host operation argument "${name}" exceeds its maximum length.`,
      );
    }
    if (definition.pattern && !new RegExp(definition.pattern, "u").test(value)) {
      throw new ZelavisHostOperationValidationError(
        `Host operation argument "${name}" has an invalid value.`,
      );
    }
  }
  return request;
}
