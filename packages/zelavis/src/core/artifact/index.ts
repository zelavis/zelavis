import { defineCompatibilityDate } from "../runtime/compatibility.js";

export const ZELAVIS_RUNTIME_ARTIFACT_V1 = "ZELAVIS_RUNTIME_ARTIFACT_V1" as const;

export type ZelavisRuntimeEngine = "node" | "bun" | "deno" | (string & {});

export interface ZelavisRuntimeArtifactManifest {
  readonly formatVersion: typeof ZELAVIS_RUNTIME_ARTIFACT_V1;
  readonly name: string;
  readonly version?: string;
  readonly runtime: ZelavisRuntimeEngine;
  readonly entrypoint: string;
  readonly files: readonly string[];
  readonly compatibilityDate?: string;
  readonly capabilities?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
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

  return Object.freeze({
    ...manifest,
    files: Object.freeze([...manifest.files].sort()),
    capabilities: manifest.capabilities
      ? Object.freeze([...manifest.capabilities].sort())
      : undefined,
    metadata: manifest.metadata
      ? Object.freeze({ ...manifest.metadata })
      : undefined,
  });
}
