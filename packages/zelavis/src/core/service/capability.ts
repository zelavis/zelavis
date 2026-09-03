/**
 * Service capability names, and who owns them.
 *
 * A capability says what contract a service satisfies. The original set —
 * `provider:auth`, `provider:payments` — is namespaced by *domain*, which
 * answers "what interface do I implement" but never "whose contract is it".
 * Two commerce plugins both scanning for `provider:payments` pick up each
 * other's payment providers, and neither can tell.
 *
 * So a capability may instead be owned by the service that defines it —
 * a core service or an installable package:
 *
 *     "zelavis/auth:credentials"
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

/**
 * Domain namespaces the Platform itself defines.
 *
 * Documentation rather than a gate: what separates a namespace from a service
 * is the shape below, not membership of this list. An allowlist would go stale
 * the moment a new domain appeared, and a domain mistaken for a service owner
 * invents an extension point nobody declared.
 */
export const ZELAVIS_PLATFORM_CAPABILITY_NAMESPACES: readonly string[] =
  Object.freeze(["web", "api", "dashboard", "provider", "app"]);

/**
 * A capability owner: a package name, or a core service name.
 *
 * Core services are unscoped and slash-separated (`zelavis/auth`,
 * `zelavis/platform`) while installable packages carry an npm scope
 * (`@zelavis/ecommerce`). Both own capabilities, so both are accepted here.
 */
const CAPABILITY_OWNER =
  /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(?:\/[a-z0-9-~][a-z0-9-._~]*)?$/u;
const CAPABILITY_NAME = /^[a-z0-9][a-z0-9-]*$/u;

export interface ParsedServiceCapability {
  /** The namespace or package name before the final colon. */
  owner: string;
  /** The contract name after it. */
  name: string;
  /** True when the owner is a service rather than a Platform domain namespace. */
  serviceOwned: boolean;
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

  if (!CAPABILITY_OWNER.test(owner)) return undefined;

  // A service name always carries a `/` — `zelavis/auth` for a core service,
  // `@acme/shop` for a package. A bare word is a domain namespace saying what
  // a plugin implements, not whose contract it satisfies. Reading `app:project`
  // as an extension of something called "app" invented an extension point that
  // nobody declared and listed unrelated services under it.
  return { owner, name, serviceOwned: owner.includes("/") };
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
