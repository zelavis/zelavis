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
    }
  | {
      readonly kind: "git";
      /** Forge host, e.g. `github.com`. */
      readonly host: string;
      /** `owner/name`. */
      readonly repository: string;
      /** A 40-character commit SHA. Never a branch or tag — see `parseGitSpec`. */
      readonly commit: string;
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
 * A Git forge this installation will fetch source archives from.
 *
 * The archive URL is a template rather than something inferred, because every
 * forge exposes commit archives at a different path and guessing wrong means
 * either a broken install or a request to somewhere unintended.
 */
export interface ZelavisGitForge {
  /** Forge host as it appears in a reference, matched exactly. */
  readonly host: string;
  /**
   * Archive URL template with `{repo}` and `{ref}` placeholders, e.g.
   * `https://codeload.github.com/{repo}/tar.gz/{ref}`. Must be https.
   */
  readonly archive: string;
}

export interface ZelavisGitSourcePolicy {
  readonly forges: readonly ZelavisGitForge[];
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
  readonly git?: ZelavisGitSourcePolicy;
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

/** `owner/name`, with the characters forges actually permit. */
const GIT_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A full commit SHA. */
const GIT_COMMIT = /^[0-9a-f]{40}$/;

/**
 * Parses `git+https://<host>/<owner>/<name>#<commit>`.
 *
 * The commit must be a full SHA. A branch or a tag names something that moves,
 * so the same reference would install different code on different days — and
 * unlike npm there is no registry digest to notice that it changed. Pinning the
 * commit is the only thing making a Git reference mean one thing.
 */
function parseGitSpec(spec: string): ZelavisPackageSourceRef {
  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    throw new ZelavisValidationError("Git source is not a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new ZelavisValidationError("Git sources must use https.");
  }
  if (url.username || url.password) {
    throw new ZelavisValidationError("Git source must not embed credentials.");
  }

  const commit = url.hash.replace(/^#/, "");
  if (!commit) {
    throw new ZelavisValidationError(
      "Git source must pin a commit, as git+https://host/owner/name#<40-character sha>.",
    );
  }
  if (!GIT_COMMIT.test(commit)) {
    throw new ZelavisValidationError(
      `"${commit}" is not a commit SHA. A branch or tag moves, so it cannot pin what gets installed.`,
    );
  }

  const repository = url.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
  if (!GIT_REPOSITORY.test(repository)) {
    throw new ZelavisValidationError(
      `"${repository}" is not an owner/name repository path.`,
    );
  }

  return { kind: "git", host: url.host, repository, commit };
}

/**
 * Parses a package source reference.
 *
 * Accepted forms:
 * - `npm:<name>` / `npm:<name>@<version>` / `npm:<name>@<dist-tag>`
 * - `git+https://<host>/<owner>/<name>#<commit>`
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

  if (trimmed.startsWith("git+https://")) {
    return parseGitSpec(trimmed.slice("git+".length));
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
    `Unsupported package source "${trimmed}". Use "npm:<name>@<version>", "git+https://host/owner/name#<commit>", or an https archive URL.`,
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

  if (ref.kind === "git") {
    if (!policy.git) {
      throw new ZelavisValidationError(
        "This installation does not allow installing packages from Git forges.",
      );
    }

    if (!policy.git.forges.some((forge) => forge.host === ref.host)) {
      throw new ZelavisValidationError(
        `Git forge ${ref.host} is not an allowed package source.`,
      );
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


/**
 * Builds the archive URL for a Git reference from its forge's template.
 *
 * The template is operator-configured, but the values substituted into it come
 * from a reference a caller supplied, so the result is validated rather than
 * trusted: it must still be https, and it must still be on the forge's own
 * origin. Both `{repo}` and `{ref}` are already constrained to characters that
 * cannot restructure a URL, and this is the check that holds if that ever
 * stops being true.
 */
export function resolveGitArchiveUrl(
  ref: Extract<ZelavisPackageSourceRef, { kind: "git" }>,
  policy: ZelavisServiceSourcePolicy | undefined,
): URL {
  const forge = policy?.git?.forges.find((candidate) => candidate.host === ref.host);
  if (!forge) {
    throw new ZelavisValidationError(
      `Git forge ${ref.host} is not an allowed package source.`,
    );
  }

  const templateOrigin = normalizeOrigin(
    forge.archive.replace(/\{repo\}|\{ref\}/g, "x"),
    "Git archive template",
  );

  const built = forge.archive
    .replaceAll("{repo}", ref.repository)
    .replaceAll("{ref}", ref.commit);

  let url: URL;
  try {
    url = new URL(built);
  } catch {
    throw new ZelavisValidationError(
      `Git forge ${ref.host} produced an invalid archive URL.`,
    );
  }

  if (url.protocol !== "https:" || url.origin !== templateOrigin) {
    throw new ZelavisValidationError(
      `Git forge ${ref.host} produced an archive URL outside its own origin.`,
    );
  }

  return url;
}
