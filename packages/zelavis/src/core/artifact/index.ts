import { defineCompatibilityDate } from "../runtime/compatibility.js";

export const ZELAVIS_RUNTIME_ARTIFACT_V1 = "ZELAVIS_RUNTIME_ARTIFACT_V1" as const;
export const ZELAVIS_RUNTIME_BUILD_PROFILE_V1 =
  "ZELAVIS_RUNTIME_BUILD_PROFILE_V1" as const;

export type ZelavisRuntimeEngine = "node" | "bun" | "deno" | (string & {});
export type ZelavisArtifactDigest = `sha256:${string}`;

export interface ZelavisRuntimeBuildProfile {
  readonly formatVersion: typeof ZELAVIS_RUNTIME_BUILD_PROFILE_V1;
  readonly runtime: ZelavisRuntimeEngine;
  readonly entrypoint: string;
  readonly compatibilityDate?: string;
  readonly conditions?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisArtifactSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly value: string;
}

export interface SignRuntimeArtifactOptions {
  readonly keyId: string;
  readonly privateKey: CryptoKey;
}

export interface ZelavisRuntimeArtifactManifest {
  readonly formatVersion: typeof ZELAVIS_RUNTIME_ARTIFACT_V1;
  readonly name: string;
  readonly version?: string;
  readonly runtime: ZelavisRuntimeEngine;
  readonly entrypoint: string;
  readonly files: readonly string[];
  /** Digest of the complete immutable artifact object. */
  readonly digest?: ZelavisArtifactDigest;
  /** Per-file digests. When present, every declared file must have one. */
  readonly fileDigests?: Readonly<Record<string, ZelavisArtifactDigest>>;
  readonly signature?: ZelavisArtifactSignature;
  readonly compatibilityDate?: string;
  readonly capabilities?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisArtifactStoreObject {
  readonly digest: ZelavisArtifactDigest;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ZelavisArtifactStorePutInput {
  readonly digest: ZelavisArtifactDigest;
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Immutable content-addressed artifact storage used by local and remote Agents. */
export interface ArtifactStore {
  has(digest: ZelavisArtifactDigest): Promise<boolean>;
  get(digest: ZelavisArtifactDigest): Promise<ZelavisArtifactStoreObject | undefined>;
  put(input: ZelavisArtifactStorePutInput): Promise<ZelavisArtifactStoreObject>;
}

function assertBundleRelativePath(value: string, field: string): void {
  const normalized = value.replace(/\\/g, "/");
  const segments = normalized.split("/");

  if (
    !value ||
    normalized.startsWith("/") ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${field} must be a bundle-relative file path.`);
  }
}

function assertDigest(value: string, field: string): asserts value is ZelavisArtifactDigest {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${field} must be a lowercase sha256 digest.`);
  }
}

function cloneArtifactObject(
  value: ZelavisArtifactStoreObject,
): ZelavisArtifactStoreObject {
  return {
    ...value,
    body: new Uint8Array(value.body),
    metadata: value.metadata ? { ...value.metadata } : undefined,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Runtime artifact signing data must be JSON-serializable.");
}

function artifactSigningData(manifest: ZelavisRuntimeArtifactManifest) {
  const { digest: _digest, signature: _signature, ...unsigned } = manifest;
  return unsigned;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Define the provider-neutral inputs that select a runtime build. */
export function defineRuntimeBuildProfile(
  profile: ZelavisRuntimeBuildProfile,
): Readonly<ZelavisRuntimeBuildProfile> {
  if (!profile || typeof profile !== "object") {
    throw new TypeError("A runtime build profile is required.");
  }
  if (profile.formatVersion !== ZELAVIS_RUNTIME_BUILD_PROFILE_V1) {
    throw new TypeError(
      `Runtime build profile formatVersion must be ${ZELAVIS_RUNTIME_BUILD_PROFILE_V1}.`,
    );
  }
  if (!profile.runtime?.trim()) {
    throw new TypeError("Runtime build profile runtime is required.");
  }
  assertBundleRelativePath(profile.entrypoint, "Runtime build profile entrypoint");
  if (profile.compatibilityDate) {
    defineCompatibilityDate(profile.compatibilityDate);
  }
  if (
    profile.conditions !== undefined &&
    (!Array.isArray(profile.conditions) ||
      profile.conditions.some((condition) => !condition.trim()))
  ) {
    throw new TypeError(
      "Runtime build profile conditions must be non-empty strings.",
    );
  }

  return Object.freeze({
    ...profile,
    conditions: profile.conditions
      ? Object.freeze([...new Set(profile.conditions)].sort())
      : undefined,
    metadata: profile.metadata
      ? Object.freeze({ ...profile.metadata })
      : undefined,
  });
}

/** Produce the canonical digest used by manifests and ArtifactStore keys. */
export async function createArtifactDigest(
  input: string | Uint8Array | ArrayBuffer,
): Promise<ZelavisArtifactDigest> {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : input instanceof Uint8Array
        ? input
        : new Uint8Array(input);
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", digestInput.buffer);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

/** Digest the canonical manifest and its file digests, excluding digest/signature. */
export function createRuntimeArtifactManifestDigest(
  manifest: ZelavisRuntimeArtifactManifest,
): Promise<ZelavisArtifactDigest> {
  return createArtifactDigest(canonicalJson(artifactSigningData(manifest)));
}

/** Attach a portable Ed25519 signature to a validated runtime artifact. */
export async function signRuntimeArtifact(
  manifest: ZelavisRuntimeArtifactManifest,
  options: SignRuntimeArtifactOptions,
): Promise<Readonly<ZelavisRuntimeArtifactManifest>> {
  if (!options.keyId?.trim()) throw new TypeError("Artifact signing keyId is required.");
  const unsigned = defineRuntimeArtifact(manifest);
  const digest = await createRuntimeArtifactManifestDigest(unsigned);
  if (unsigned.digest && unsigned.digest !== digest) {
    throw new TypeError(
      `Runtime artifact manifest digest mismatch: expected ${unsigned.digest}, received ${digest}.`,
    );
  }
  const value = base64Url(new Uint8Array(await crypto.subtle.sign(
    "Ed25519",
    options.privateKey,
    new TextEncoder().encode(canonicalJson({
      ...artifactSigningData(unsigned),
      digest,
    })),
  )));
  return defineRuntimeArtifact({
    ...unsigned,
    digest,
    signature: { algorithm: "Ed25519", keyId: options.keyId, value },
  });
}

/** Verify the digest and Ed25519 signature of a runtime artifact manifest. */
export async function verifyRuntimeArtifactSignature(
  manifest: ZelavisRuntimeArtifactManifest,
  publicKey: CryptoKey,
): Promise<boolean> {
  const artifact = defineRuntimeArtifact(manifest);
  if (!artifact.digest || artifact.signature?.algorithm !== "Ed25519") return false;
  const digest = await createRuntimeArtifactManifestDigest(artifact);
  if (digest !== artifact.digest) return false;
  return crypto.subtle.verify(
    "Ed25519",
    publicKey,
    fromBase64Url(artifact.signature.value) as BufferSource,
    new TextEncoder().encode(canonicalJson({
      ...artifactSigningData(artifact),
      digest,
    })),
  );
}

/** Define a portable, serializable description of a built runtime artifact. */
export function defineRuntimeArtifact(
  manifest: ZelavisRuntimeArtifactManifest,
): Readonly<ZelavisRuntimeArtifactManifest> {
  if (!manifest || typeof manifest !== "object") {
    throw new TypeError("A runtime artifact manifest is required.");
  }
  if (manifest.formatVersion !== ZELAVIS_RUNTIME_ARTIFACT_V1) {
    throw new TypeError(
      `Runtime artifact formatVersion must be ${ZELAVIS_RUNTIME_ARTIFACT_V1}.`,
    );
  }
  if (!manifest.name?.trim()) {
    throw new TypeError("Runtime artifact name is required.");
  }
  if (!manifest.runtime?.trim()) {
    throw new TypeError("Runtime artifact runtime is required.");
  }
  if (!Array.isArray(manifest.files)) {
    throw new TypeError("Runtime artifact files must be an array.");
  }
  if (
    manifest.capabilities !== undefined &&
    !Array.isArray(manifest.capabilities)
  ) {
    throw new TypeError("Runtime artifact capabilities must be an array.");
  }

  assertBundleRelativePath(manifest.entrypoint, "Runtime artifact entrypoint");
  for (const file of manifest.files) {
    assertBundleRelativePath(file, "Runtime artifact file");
  }
  if (!manifest.files.includes(manifest.entrypoint)) {
    throw new TypeError("Runtime artifact files must include the entrypoint.");
  }
  if (new Set(manifest.files).size !== manifest.files.length) {
    throw new TypeError("Runtime artifact files must not contain duplicates.");
  }
  if (manifest.compatibilityDate) {
    defineCompatibilityDate(manifest.compatibilityDate);
  }
  if (manifest.digest) {
    assertDigest(manifest.digest, "Runtime artifact digest");
  }
  if (manifest.fileDigests) {
    const digestFiles = Object.keys(manifest.fileDigests).sort();
    const files = [...manifest.files].sort();
    if (
      digestFiles.length !== files.length ||
      digestFiles.some((file, index) => file !== files[index])
    ) {
      throw new TypeError(
        "Runtime artifact fileDigests must contain exactly every declared file.",
      );
    }
    for (const [file, digest] of Object.entries(manifest.fileDigests)) {
      assertBundleRelativePath(file, "Runtime artifact digest file");
      assertDigest(digest, `Runtime artifact digest for ${file}`);
    }
  }
  if (manifest.signature) {
    if (
      !manifest.signature.algorithm?.trim() ||
      !manifest.signature.keyId?.trim() ||
      !manifest.signature.value?.trim()
    ) {
      throw new TypeError(
        "Runtime artifact signatures require algorithm, keyId, and value.",
      );
    }
  }

  return Object.freeze({
    ...manifest,
    files: Object.freeze([...manifest.files].sort()),
    capabilities: manifest.capabilities
      ? Object.freeze([...manifest.capabilities].sort())
      : undefined,
    fileDigests: manifest.fileDigests
      ? Object.freeze(
          Object.fromEntries(
            Object.entries(manifest.fileDigests).sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        )
      : undefined,
    signature: manifest.signature
      ? Object.freeze({ ...manifest.signature })
      : undefined,
    metadata: manifest.metadata
      ? Object.freeze({ ...manifest.metadata })
      : undefined,
  });
}

/** A small runtime-neutral ArtifactStore for embedding and focused tests. */
export function createMemoryArtifactStore(): ArtifactStore {
  const objects = new Map<ZelavisArtifactDigest, ZelavisArtifactStoreObject>();

  return {
    async has(digest) {
      assertDigest(digest, "ArtifactStore digest");
      return objects.has(digest);
    },
    async get(digest) {
      assertDigest(digest, "ArtifactStore digest");
      const object = objects.get(digest);
      return object ? cloneArtifactObject(object) : undefined;
    },
    async put(input) {
      assertDigest(input.digest, "ArtifactStore digest");
      const actualDigest = await createArtifactDigest(input.body);
      if (actualDigest !== input.digest) {
        throw new TypeError(
          `ArtifactStore content digest mismatch: expected ${input.digest}, received ${actualDigest}.`,
        );
      }
      const existing = objects.get(input.digest);
      if (existing) {
        return cloneArtifactObject(existing);
      }
      const object: ZelavisArtifactStoreObject = {
        digest: input.digest,
        body: new Uint8Array(input.body),
        contentType: input.contentType,
        metadata: input.metadata ? { ...input.metadata } : undefined,
      };
      objects.set(input.digest, object);
      return cloneArtifactObject(object);
    },
  };
}
