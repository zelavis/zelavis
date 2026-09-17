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
  /**
   * Absolute path of the interpreter a script artifact runs with. Named here,
   * inside the signature, rather than in a shebang the host resolves: an
   * artifact starting with `#!` and no interpreter is refused. Absent for a
   * native executable.
   */
  readonly interpreter?: string;
  /**
   * Who may request this operation, part of the release signature so an
   * installation cannot loosen it. The Platform issues authority only when the
   * caller holds `permission` for the scope: `project` requires a Project id
   * and a grant for that Project (or the top-level permission); `system`
   * refuses a Project id. An operation without it cannot be requested.
   */
  readonly authorization?: {
    readonly permission: string;
    readonly scope: "project" | "system";
  };
  /**
   * A structured result the operation returns. Output is otherwise never
   * kept; declaring this in the signed manifest states that stdout is a JSON
   * object of at most `maxBytes` that is safe to journal and return to
   * whoever may read the operation. Anything else fails the operation.
   */
  readonly result?: {
    readonly format: "json";
    readonly maxBytes: number;
  };
}

export const MAX_HOST_OPERATION_RESULT_BYTES = 65_536;

/**
 * A manifest as installed: the release signature travels with it.
 *
 * The signature covers `HOST_OPERATION_MANIFEST_SIGNATURE_CONTEXT` followed by
 * the canonical JSON of `manifest` and `signedAt`, so neither a field nor the
 * signing time can be changed or reordered without invalidating it.
 */
export interface ZelavisSignedHostOperationManifest {
  readonly manifest: ZelavisHostOperationManifest;
  readonly keyId: string;
  /** When the release was signed; must fall inside the key's validity window. */
  readonly signedAt: string;
  /** Base64 Ed25519 signature. */
  readonly signature: string;
}

/**
 * A release signing key the operator trusts.
 *
 * Rotation is overlapping windows: publish the next key before the current
 * one's `notAfter`, sign new releases with it, and let the old window close.
 * Manifests signed inside a closed window stay valid; revoking a key
 * invalidates every manifest it ever signed.
 */
export interface ZelavisHostOperationTrustKey {
  readonly keyId: string;
  /** Base64 raw 32-byte Ed25519 public key. */
  readonly publicKey: string;
  readonly notBefore: string;
  readonly notAfter: string;
}

export interface ZelavisHostOperationTrustStore {
  readonly keys: readonly ZelavisHostOperationTrustKey[];
  readonly revokedKeyIds?: readonly string[];
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
  /** The declared JSON result, when the manifest declares one and it was valid. */
  readonly result?: Readonly<Record<string, unknown>>;
  /** Why a declared result was rejected (the operation then failed). */
  readonly resultError?: string;
  /** The deadline was reached and the operation's process group was killed. */
  readonly timedOut?: boolean;
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

export const HOST_OPERATION_MANIFEST_SIGNATURE_CONTEXT =
  "zelavis-host-operation-manifest-v1\n";
/** Allowed clock skew for a `signedAt` slightly ahead of the verifier. */
const SIGNING_CLOCK_SKEW_MS = 5 * 60_000;
const KEY_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9]*(?:[.:-][a-z0-9]+){0,15}$/;

/** JSON with object keys sorted at every depth; arrays keep their order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function hostOperationSigningPayload(
  manifest: ZelavisHostOperationManifest,
  signedAt: string,
): Uint8Array {
  return new TextEncoder().encode(
    `${HOST_OPERATION_MANIFEST_SIGNATURE_CONTEXT}${canonicalJson({ manifest, signedAt })}`,
  );
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new ZelavisHostOperationValidationError("Invalid base64 value.");
  }
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The Ed25519 key a trust store vouches for under `keyId` at time `at`.
 *
 * Returns `undefined` for an unknown, duplicated, revoked or out-of-window key
 * and for a malformed public key, so every caller refuses the same cases.
 */
export async function resolveTrustedEd25519Key(
  trust: ZelavisHostOperationTrustStore,
  keyId: string,
  at: number,
): Promise<CryptoKey | undefined> {
  if (typeof keyId !== "string" || !KEY_ID_PATTERN.test(keyId)) return undefined;
  if (trust.revokedKeyIds?.includes(keyId)) return undefined;
  const matching = trust.keys.filter((key) => key.keyId === keyId);
  if (matching.length !== 1) return undefined;
  const key = matching[0]!;
  const notBefore = Date.parse(key.notBefore);
  const notAfter = Date.parse(key.notAfter);
  if (!Number.isFinite(at) || !(at >= notBefore && at <= notAfter)) return undefined;
  try {
    const raw = fromBase64(key.publicKey);
    if (raw.byteLength !== 32) return undefined;
    return await crypto.subtle.importKey("raw", raw as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return undefined;
  }
}

/** Release tooling: signs a validated manifest with an Ed25519 private key. */
export async function signHostOperationManifest(input: {
  readonly manifest: ZelavisHostOperationManifest;
  readonly keyId: string;
  readonly privateKey: CryptoKey;
  readonly signedAt?: string;
}): Promise<ZelavisSignedHostOperationManifest> {
  const manifest = validateHostOperationManifest(input.manifest);
  const signedAt = input.signedAt ?? new Date().toISOString();
  const signature = await crypto.subtle.sign(
    "Ed25519",
    input.privateKey,
    hostOperationSigningPayload(manifest, signedAt) as BufferSource,
  );
  return Object.freeze({
    manifest,
    keyId: input.keyId,
    signedAt,
    signature: toBase64(new Uint8Array(signature)),
  });
}

/**
 * Verifies an installed manifest against the operator's trust store and
 * returns the validated manifest. Refuses unknown or revoked keys, a signing
 * time outside the key's window or in the future, and any altered field.
 */
export async function verifySignedHostOperationManifest(
  signed: ZelavisSignedHostOperationManifest,
  trust: ZelavisHostOperationTrustStore,
  now = Date.now(),
): Promise<ZelavisHostOperationManifest> {
  if (!signed || typeof signed !== "object" || typeof signed.keyId !== "string" || !KEY_ID_PATTERN.test(signed.keyId)) {
    throw new ZelavisHostOperationValidationError("Signed host operation manifest has an invalid key id.");
  }
  if (trust.revokedKeyIds?.includes(signed.keyId)) {
    throw new ZelavisHostOperationValidationError(
      `Host operation manifest was signed by revoked key "${signed.keyId}".`,
    );
  }
  if (trust.keys.filter((key) => key.keyId === signed.keyId).length !== 1) {
    throw new ZelavisHostOperationValidationError(
      `Host operation manifest was signed by untrusted key "${signed.keyId}".`,
    );
  }
  const signedAt = Date.parse(signed.signedAt);
  const publicKey = typeof signed.signedAt === "string" && signedAt <= now + SIGNING_CLOCK_SKEW_MS
    ? await resolveTrustedEd25519Key(trust, signed.keyId, signedAt)
    : undefined;
  if (!publicKey) {
    throw new ZelavisHostOperationValidationError(
      `Host operation manifest signing time is outside key "${signed.keyId}"'s validity window.`,
    );
  }
  const manifest = validateHostOperationManifest(signed.manifest);
  let valid = false;
  try {
    const signature = fromBase64(signed.signature);
    valid = signature.byteLength === 64 && await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      signature as BufferSource,
      hostOperationSigningPayload(manifest, signed.signedAt) as BufferSource,
    );
  } catch {
    valid = false;
  }
  if (!valid) {
    throw new ZelavisHostOperationValidationError(
      `Host operation manifest signature is invalid for "${manifest.id}" ${manifest.version}.`,
    );
  }
  return manifest;
}

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
  const argumentsList = Object.entries(request.arguments);
  if (argumentsList.length > 64 || argumentsList.some(([name, value]) =>
    !ID_PATTERN.test(name) || name.length > 64 || value.includes("\0") || value.length > 16_384
  ) || new TextEncoder().encode(JSON.stringify(request.arguments)).byteLength > 65_536) {
    throw new ZelavisHostOperationValidationError(
      "Host operation arguments exceed protocol bounds or contain invalid names/NUL bytes.",
    );
  }
  const deadline = Date.parse(request.deadline);
  if (!Number.isFinite(deadline) || deadline <= now || deadline > now + 15 * 60_000) {
    throw new ZelavisHostOperationValidationError(
      "Host operation deadline must be in the next 15 minutes.",
    );
  }
  return Object.freeze({ ...request, arguments: Object.freeze({ ...request.arguments }) });
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
  if (
    !manifest.arguments ||
    typeof manifest.arguments !== "object" ||
    Array.isArray(manifest.arguments) ||
    Object.keys(manifest).some((key) =>
      !["id", "version", "sha256", "arguments", "interpreter", "authorization", "result"].includes(key))
  ) {
    throw new ZelavisHostOperationValidationError(
      "Host operation manifest has unknown fields or invalid arguments.",
    );
  }
  if (
    manifest.authorization !== undefined &&
    (!manifest.authorization ||
      typeof manifest.authorization !== "object" ||
      Object.keys(manifest.authorization).some((key) => key !== "permission" && key !== "scope") ||
      typeof manifest.authorization.permission !== "string" ||
      !PERMISSION_PATTERN.test(manifest.authorization.permission) ||
      (manifest.authorization.scope !== "project" && manifest.authorization.scope !== "system"))
  ) {
    throw new ZelavisHostOperationValidationError(
      'Host operation authorization must be { permission: "<name>", scope: "project" | "system" }.',
    );
  }
  if (
    manifest.result !== undefined &&
    (!manifest.result ||
      typeof manifest.result !== "object" ||
      Object.keys(manifest.result).some((key) => key !== "format" && key !== "maxBytes") ||
      manifest.result.format !== "json" ||
      !Number.isSafeInteger(manifest.result.maxBytes) ||
      manifest.result.maxBytes < 2 ||
      manifest.result.maxBytes > MAX_HOST_OPERATION_RESULT_BYTES)
  ) {
    throw new ZelavisHostOperationValidationError(
      `Host operation result must be { format: "json", maxBytes: 2..${MAX_HOST_OPERATION_RESULT_BYTES} }.`,
    );
  }
  if (
    manifest.interpreter !== undefined &&
    (typeof manifest.interpreter !== "string" ||
      !manifest.interpreter.startsWith("/") ||
      manifest.interpreter.length > 512 ||
      manifest.interpreter.includes("\0") ||
      manifest.interpreter.split("/").some((part) => part === "." || part === ".."))
  ) {
    throw new ZelavisHostOperationValidationError(
      "Host operation interpreter must be a normalized absolute path.",
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
  request = validateHostOperationRequestShape(request, now);
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
  if (supplied.some((name) => !Object.hasOwn(manifest.arguments, name))) {
    throw new ZelavisHostOperationValidationError(
      "Host operation request contains an undeclared argument.",
    );
  }
  for (const [name, definition] of Object.entries(manifest.arguments)) {
    const value = Object.hasOwn(request.arguments, name) ? request.arguments[name] : undefined;
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
