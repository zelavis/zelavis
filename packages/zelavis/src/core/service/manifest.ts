import {
  ZELAVIS_SERVICE_KINDS,
  type ZelavisServiceKind,
} from "./definition.js";
import { parseServiceCapability } from "./capability.js";
import { readFrontendManifest } from "./frontend.js";

export interface ZelavisManifestConfig {
  kind: string;
  namespace?: string;
  capabilities?: readonly string[];
  marketplace?: Record<string, unknown>;
  [key: string]: unknown;
}

const RESERVED_PLUGIN_NAMESPACES = new Set([
  "__proto__", "prototype", "constructor", "then", "toJSON",
]);

export function validatePluginNamespace(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(value) ||
      RESERVED_PLUGIN_NAMESPACES.has(value)) {
    throw new TypeError(
      '"zelavis.namespace" must be a non-reserved identifier beginning with a lowercase letter and containing only letters and digits.',
    );
  }
  return value;
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
 * - Requires `zelavis.kind` to be one of the official kinds
 * - Requires `type: "module"` and `exports`, and rejects legacy `main`, for
 *   every kind except `frontend`, which may ship files with no JS entry
 * - Validates the `zelavis.frontend` block when the kind is `frontend`
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

  // Checked rather than merely declared. An unrecognised kind used to load
  // fine and do nothing, so a typo produced a service that silently never
  // participated in anything.
  if (!ZELAVIS_SERVICE_KINDS.includes(kind as ZelavisServiceKind)) {
    throw new TypeError(
      `Invalid Zelavis service "${name}":\n"zelavis.kind" must be one of ${ZELAVIS_SERVICE_KINDS.join(", ")}, not "${kind}".`,
    );
  }

  // Server frontends run in their Project process. Their npm exports are not
  // control-plane plugin entrypoints. A static frontend may opt into the SDK.
  const executesInHost = kind !== "frontend" || (
    ((zelavis as Record<string, unknown>).frontend as { runtime?: string } | undefined)?.runtime === "static" &&
    manifest.exports !== undefined
  );

  // Applied to every kind that ships JavaScript, not only "plugin".
  //
  // These checks are about the package being modern ESM with a resolvable
  // entry — a property of how the code is shipped, not of what the service is.
  // Gating them on the "plugin" label meant a first-party service had to
  // mislabel itself as a plugin to get its manifest validated at all.
  // A frontend is exempt because it may be files with no JavaScript entry.
  if (executesInHost) {
    if (manifest.type !== "module") {
      throw new TypeError(
        `Invalid Zelavis service "${name}":\npackage.json must contain "type": "module".`,
      );
    }

    if (
      manifest.exports === undefined ||
      manifest.exports === null ||
      manifest.exports === ""
    ) {
      throw new TypeError(
        `Invalid Zelavis service "${name}":\npackage.json must define "exports".`,
      );
    }

    if (manifest.main !== undefined) {
      throw new TypeError(
        `Invalid Zelavis service "${name}":\n"main" is not supported.\nUse the modern "exports" field instead.`,
      );
    }

    if (
      manifest.entry !== undefined ||
      (zelavis as Record<string, unknown>).entry !== undefined
    ) {
      throw new TypeError(
        `Invalid Zelavis service "${name}":\n"entry" is not supported.\nUse the standard package.json "exports" field instead.`,
      );
    }
  }

  // Validated rather than merely carried. A capability is how a provider finds
  // the plugin it extends, so a typo in one is a plugin that installs cleanly
  // and is then silently never discovered — the least debuggable failure the
  // registry can produce.
  const capabilities = (zelavis as Record<string, unknown>).capabilities;
  if (capabilities !== undefined) {
    if (!Array.isArray(capabilities)) {
      throw new TypeError(
        `Invalid Zelavis service "${name}":\n"zelavis.capabilities" must be an array of strings.`,
      );
    }
    for (const capability of capabilities) {
      if (typeof capability !== "string" || !parseServiceCapability(capability)) {
        throw new TypeError(
          `Invalid Zelavis service "${name}":\n"${String(capability)}" is not a valid capability.\nUse "<package or namespace>:<name>", as in "@zelavis/auth:credentials".`,
        );
      }
    }
  }

  if (kind === "frontend") {
    // Validate the frontend block here so a malformed one is refused at install
    // rather than surfacing as a broken site the first time someone visits it.
    readFrontendManifest(manifest as ZelavisPackageManifest);
  }

  // Code-providing packages choose their public name; it is never inferred
  // from an npm package name. File-only frontends may opt into a namespace.
  const namespace = (zelavis as Record<string, unknown>).namespace;
  if (executesInHost || namespace !== undefined) {
    validatePluginNamespace(namespace);
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
