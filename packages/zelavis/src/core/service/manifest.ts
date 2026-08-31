import { readFrontendManifest } from "./frontend.js";

export interface ZelavisManifestConfig {
  kind: string;
  capabilities?: readonly string[];
  marketplace?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ZelavisPackageManifest {
  name: string;
  version?: string;
  type?: string;
  exports?: unknown;
  main?: unknown;
  zelavis?: ZelavisManifestConfig;
  [key: string]: unknown;
}

/**
 * Validates a package.json manifest for Zelavis services and plugins according
 * to the modern ESM plugin contract:
 * - Requires package.json with a valid string name
 * - Requires `zelavis.kind`
 * - If `kind === "plugin"`, requires `type: "module"`
 * - If `kind === "plugin"`, requires `exports`
 * - If `kind === "plugin"`, rejects legacy `main`
 */
export function validatePluginPackageManifest(
  rawManifest: unknown,
): ZelavisPackageManifest {
  if (!rawManifest || typeof rawManifest !== "object") {
    throw new TypeError("A package.json manifest object is required.");
  }

  const manifest = rawManifest as Record<string, unknown>;
  const name = typeof manifest.name === "string" ? manifest.name.trim() : "";
  if (!name) {
    throw new TypeError("A package.json manifest must include a string name.");
  }

  const zelavis = manifest.zelavis;
  if (
    !zelavis ||
    typeof zelavis !== "object" ||
    !("kind" in zelavis) ||
    typeof (zelavis as Record<string, unknown>).kind !== "string" ||
    !(zelavis as Record<string, unknown>).kind!.toString().trim()
  ) {
    throw new TypeError(
      `Invalid Zelavis service "${name}":\nmissing "zelavis.kind" in package.json.`,
    );
  }

  const kind = (zelavis as Record<string, unknown>).kind!.toString().trim();

  if (kind === "plugin") {
    if (manifest.type !== "module") {
      throw new TypeError(
        `Invalid Zelavis plugin "${name}":\npackage.json must contain "type": "module".`,
      );
    }

    if (
      manifest.exports === undefined ||
      manifest.exports === null ||
      manifest.exports === ""
    ) {
      throw new TypeError(
        `Invalid Zelavis plugin "${name}":\npackage.json must define "exports".`,
      );
    }

    if (manifest.main !== undefined) {
      throw new TypeError(
        `Invalid Zelavis plugin "${name}":\n"main" is not supported for Zelavis plugins.\nUse the modern "exports" field instead.`,
      );
    }
  }

  if (kind === "frontend") {
    // Validate the frontend block here so a malformed one is refused at install
    // rather than surfacing as a broken site the first time someone visits it.
    readFrontendManifest(manifest as ZelavisPackageManifest);
  }

  return manifest as ZelavisPackageManifest;
}

/**
 * Resolves the primary entrypoint specifier or path from a package.json `exports` field.
 */
export function resolvePackageExportsEntry(exportsField: unknown): string {
  if (typeof exportsField === "string" && exportsField.trim()) {
    return exportsField.trim();
  }

  if (typeof exportsField === "object" && exportsField !== null) {
    const record = exportsField as Record<string, unknown>;

    if ("." in record) {
      const dot = record["."];
      if (typeof dot === "string" && dot.trim()) {
        return dot.trim();
      }
      if (typeof dot === "object" && dot !== null) {
        const dotRecord = dot as Record<string, unknown>;
        const target = dotRecord.import ?? dotRecord.default ?? dotRecord.node;
        if (typeof target === "string" && target.trim()) {
          return target.trim();
        }
      }
    }

    const target = record.import ?? record.default ?? record.node;
    if (typeof target === "string" && target.trim()) {
      return target.trim();
    }
  }

  throw new TypeError("Unable to resolve package exports entry point.");
}
