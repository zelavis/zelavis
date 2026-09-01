/**
 * Trust policy for acquiring service packages from remote sources.
 *
 * Installing a package means executing its code with Platform authority, so
 * every acquisition answers three questions before a byte is fetched: is this
 * source allowed at all, is the thing we fetched the thing we asked for, and
 * did it come from where it claimed. This module owns the first and third; the
 * second is integrity verification at download time.
 *
 * Everything here is pure and runtime-neutral — no fetching, no filesystem —
 * so the policy can be tested and reasoned about on its own.
 */
import { ZelavisValidationError } from "./shared.js";

/** A validated reference to a package that can be acquired. */
export type ZelavisPackageSourceRef =
  | {
      readonly kind: "npm";
      /** Full package name, scope included. */
      readonly name: string;
      /** Exact version or a dist-tag; a tag is resolved against the registry. */
      readonly version: string;
      /** Registry origin, no trailing slash. */
      readonly registry: string;
    }
  | {
      readonly kind: "https";
      /** Absolute URL of a package archive. */
      readonly url: string;
    };

export interface ZelavisNpmSourcePolicy {
  /**
   * Registry origins that may be fetched from, matched exactly. A registry not
   * listed here cannot be reached even if a reference names it.
   */
  readonly registries: readonly string[];
  /**
   * Package scopes that may be installed, e.g. `["@zelavis"]`. Omit to allow
   * any package on an allowed registry. Unscoped packages are allowed only
   * when this is omitted.
   */
  readonly scopes?: readonly string[];
}

export interface ZelavisHttpsSourcePolicy {
  /** Hosts that may be fetched from, matched exactly. */
  readonly hosts: readonly string[];
}

/**
 * Which remote sources this installation will acquire packages from.
 *
 * There is no default. An installation that has not configured a policy cannot
 * acquire anything remotely, which is the safe posture: the failure mode of
 * default-deny is an install that does not happen, and the failure mode of
 * default-allow is arbitrary remote code running with Platform authority.
 */
export interface ZelavisServiceSourcePolicy {
  readonly npm?: ZelavisNpmSourcePolicy;
  readonly https?: ZelavisHttpsSourcePolicy;
}

export const ZELAVIS_DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** Package name rules, matching npm's own: no path traversal, no URL tricks. */
const NPM_UNSCOPED = /^[a-z0-9][a-z0-9._-]*$/;
const NPM_SCOPE = /^@[a-z0-9][a-z0-9._-]*$/;
/**
 * An exact semver version: three numeric parts, with optional prerelease and
 * build metadata. Deliberately strict — `1`, `1.2`, and `1.x` are partial
 * versions, which is to say ranges wearing a version's clothes.
 */
const NPM_EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
/** A dist-tag, which npm requires to not be parseable as a version. */
const NPM_DIST_TAG = /^[A-Za-z][0-9A-Za-z._-]*$/;

function normalizeOrigin(input: string, label: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new ZelavisValidationError(`${label} must be an absolute URL.`);
  }

  if (url.protocol !== "https:") {
    throw new ZelavisValidationError(`${label} must use https.`);
  }

  // Compared against other origins, so anything that could make two different
  // origins compare equal has to be gone before it is stored.
  if (url.username || url.password) {
    throw new ZelavisValidationError(`${label} must not embed credentials.`);
  }

  return url.origin;
}

function assertPackageName(name: string): void {
  if (name.startsWith("@")) {
    const separator = name.indexOf("/");
    if (separator < 0) {
      throw new ZelavisValidationError(
        `Scoped package name "${name}" is missing its package part.`,
      );
    }

    const scope = name.slice(0, separator);
    const unscoped = name.slice(separator + 1);

    if (!NPM_SCOPE.test(scope) || !NPM_UNSCOPED.test(unscoped)) {
      throw new ZelavisValidationError(`"${name}" is not a valid package name.`);
    }
    return;
  }

  if (!NPM_UNSCOPED.test(name)) {
    throw new ZelavisValidationError(`"${name}" is not a valid package name.`);
  }
}

/**
 * Parses `npm:<name>[@<version>]`.
 *
 * A version range is rejected rather than resolved. What gets installed must be
 * exactly what the reference named, or a dist-tag whose resolution is recorded
 * — a range would let the same reference install different code on different
 * days with no record of which.
 */
function parseNpmSpec(
  spec: string,
  registry: string,
): ZelavisPackageSourceRef {
  const separator = spec.lastIndexOf("@");
  // A leading `@` is the scope, not a version separator.
  const hasVersion = separator > 0;
  const name = hasVersion ? spec.slice(0, separator) : spec;
  const version = hasVersion ? spec.slice(separator + 1) : "latest";

  assertPackageName(name);

  if (!NPM_EXACT_VERSION.test(version) && !NPM_DIST_TAG.test(version)) {
    throw new ZelavisValidationError(
      `"${version}" is not an exact version or a dist-tag. A reference must name one package: a range would let the same reference install different code on different days.`,
    );
  }

  return { kind: "npm", name, version, registry };
}

/**
 * Parses a package source reference.
 *
 * Accepted forms:
 * - `npm:<name>` / `npm:<name>@<version>` / `npm:<name>@<dist-tag>`
 * - `https://<host>/<path>` — an archive URL
 */
export function parsePackageSourceRef(
  input: string,
  options: { readonly defaultRegistry?: string } = {},
): ZelavisPackageSourceRef {
  const trimmed = typeof input === "string" ? input.trim() : "";

  if (!trimmed) {
    throw new ZelavisValidationError("A package source reference is required.");
  }

  if (trimmed.startsWith("npm:")) {
    const registry = normalizeOrigin(
      options.defaultRegistry ?? ZELAVIS_DEFAULT_NPM_REGISTRY,
      "Package registry",
    );
    return parseNpmSpec(trimmed.slice("npm:".length), registry);
  }

  if (trimmed.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ZelavisValidationError(
        "Package archive URL is not a valid URL.",
      );
    }

    if (url.username || url.password) {
      throw new ZelavisValidationError(
        "Package archive URL must not embed credentials.",
      );
    }

    return { kind: "https", url: url.toString() };
  }

  throw new ZelavisValidationError(
    `Unsupported package source "${trimmed}". Use "npm:<name>@<version>" or an https archive URL.`,
  );
}

function packageScope(name: string): string | undefined {
  return name.startsWith("@") ? name.slice(0, name.indexOf("/")) : undefined;
}

/**
 * Throws unless the policy allows this reference.
 *
 * Matching is exact throughout. A suffix or substring check on an origin would
 * let `https://registry.npmjs.org.example.test` pass as the npm registry, and
 * the same check on a scope would let `@zelavis-evil` pass as `@zelavis`.
 */
export function assertPackageSourceAllowed(
  ref: ZelavisPackageSourceRef,
  policy: ZelavisServiceSourcePolicy | undefined,
): void {
  if (!policy) {
    throw new ZelavisValidationError(
      "This installation does not allow acquiring packages from remote sources.",
    );
  }

  if (ref.kind === "npm") {
    if (!policy.npm) {
      throw new ZelavisValidationError(
        "This installation does not allow installing packages from npm.",
      );
    }

    const allowed = policy.npm.registries.some(
      (registry) => normalizeOrigin(registry, "Allowed registry") === ref.registry,
    );
    if (!allowed) {
      throw new ZelavisValidationError(
        `Registry ${ref.registry} is not an allowed package source.`,
      );
    }

    if (policy.npm.scopes) {
      const scope = packageScope(ref.name);
      if (!scope || !policy.npm.scopes.includes(scope)) {
        throw new ZelavisValidationError(
          `Package ${ref.name} is outside the scopes this installation installs from.`,
        );
      }
    }

    return;
  }

  if (!policy.https) {
    throw new ZelavisValidationError(
      "This installation does not allow installing packages from arbitrary URLs.",
    );
  }

  const host = new URL(ref.url).host;
  if (!policy.https.hosts.includes(host)) {
    throw new ZelavisValidationError(
      `Host ${host} is not an allowed package source.`,
    );
  }
}

/**
 * Throws unless a tarball URL belongs to the registry that advertised it.
 *
 * Registry metadata names its own download URL, so a compromised or hostile
 * registry could point at a host the policy never approved. The allow-list has
 * to be enforced against the URL actually fetched, not only the one requested.
 */
export function assertTarballOrigin(
  tarballUrl: string,
  registry: string,
): URL {
  let url: URL;
  try {
    url = new URL(tarballUrl);
  } catch {
    throw new ZelavisValidationError(
      "Registry metadata contained an invalid tarball URL.",
    );
  }

  if (url.origin !== registry) {
    throw new ZelavisValidationError(
      `Registry ${registry} advertised a tarball on ${url.origin}, which is not an allowed package source.`,
    );
  }

  return url;
}
