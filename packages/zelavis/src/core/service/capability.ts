/**
 * Service capability names, and who owns them.
 *
 * A capability says what contract a service satisfies. The original set —
 * `provider:auth`, `provider:payments` — is namespaced by *domain*, which
 * answers "what interface do I implement" but never "whose contract is it".
 * Two commerce plugins both scanning for `provider:payments` pick up each
 * other's payment providers, and neither can tell.
 *
 * So a capability may instead be owned by the package that defines it:
 *
 *     "@zelavis/auth:credentials"
 *     "@zelavis/ecommerce:payments"
 *
 * Discovery stays a flat scan over installed services. There is deliberately
 * no parent/child graph: a provider naming an owner is *asking* to be
 * considered by it, never being granted anything. The owning plugin still
 * finds providers by capability and still validates them against its own
 * registration contract, exactly as before. Nothing here confers trust, and a
 * service that names an owner which is not installed is simply never
 * discovered.
 */

/** Domain namespaces the Platform itself defines. */
export const ZELAVIS_PLATFORM_CAPABILITY_NAMESPACES: readonly string[] =
  Object.freeze(["web", "api", "dashboard", "provider"]);

const PACKAGE_OWNER = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u;
const CAPABILITY_NAME = /^[a-z0-9][a-z0-9-]*$/u;

export interface ParsedServiceCapability {
  /** The namespace or package name before the final colon. */
  owner: string;
  /** The contract name after it. */
  name: string;
  /** True when the owner is a package rather than a Platform namespace. */
  packageOwned: boolean;
}

/**
 * Splits on the LAST colon, because a scoped package name contains none but a
 * capability like `@zelavis/auth:credentials` must not be split on the `@`.
 */
export function parseServiceCapability(
  capability: string,
): ParsedServiceCapability | undefined {
  if (typeof capability !== "string") return undefined;
  const separator = capability.lastIndexOf(":");
  if (separator <= 0 || separator === capability.length - 1) return undefined;

  const owner = capability.slice(0, separator);
  const name = capability.slice(separator + 1);
  if (!CAPABILITY_NAME.test(name)) return undefined;

  if (ZELAVIS_PLATFORM_CAPABILITY_NAMESPACES.includes(owner)) {
    return { owner, name, packageOwned: false };
  }
  if (PACKAGE_OWNER.test(owner)) {
    return { owner, name, packageOwned: true };
  }
  return undefined;
}

/** Builds the capability string a service declares to extend `owner`. */
export function serviceCapabilityFor(owner: string, name: string): string {
  const capability = `${owner}:${name}`;
  if (!parseServiceCapability(capability)) {
    throw new TypeError(
      `"${capability}" is not a valid Zelavis service capability. Use "<package or namespace>:<name>", as in "@zelavis/auth:credentials".`,
    );
  }
  return capability;
}

/**
 * Reports whether `capabilities` declares `name` on behalf of `owner`.
 *
 * Comparison is exact. A provider that means to extend `@zelavis/auth` has to
 * say so; nothing is inferred from a similar-looking package name.
 */
export function declaresServiceCapability(
  capabilities: readonly string[] | undefined,
  owner: string,
  name: string,
): boolean {
  if (!capabilities?.length) return false;
  const wanted = `${owner}:${name}`;
  return capabilities.some((capability) => capability === wanted);
}
