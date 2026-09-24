import { parseServiceCapability } from "./capability.js";

/**
 * Which services extend which.
 *
 * A capability owned by a service — `zelavis/identity:oauth`, not the domain
 * namespace `provider:auth` — says the plugin declaring it exists to extend
 * that one. Nothing else marks it: a child plugin is an ordinary plugin,
 * installed the same way, and the only difference is who it points at.
 *
 * That relationship is what lets an extension be listed where it makes sense —
 * beside the plugin it extends, rather than in a general catalogue where a
 * payment provider sits next to a dashboard theme and neither means much.
 */

export interface ServiceExtensionPoint {
  /** The service being extended. */
  owner: string;
  /** Capability names declared against that owner. */
  capabilities: readonly string[];
}

function capabilitiesOf(service: {
  capabilities?: readonly string[];
}): readonly string[] {
  return service.capabilities ?? [];
}

/**
 * The services this one extends, if any.
 *
 * Empty for an ordinary plugin, which is the common case: extending something
 * is a deliberate declaration rather than the default.
 */
export function serviceExtensionPoints(service: {
  capabilities?: readonly string[];
}): readonly ServiceExtensionPoint[] {
  const owners = new Map<string, string[]>();

  for (const capability of capabilitiesOf(service)) {
    const parsed = parseServiceCapability(capability);
    // Domain namespaces (`api:routes`, `provider:auth`) name no owner, so a
    // service declaring only those extends nothing in particular.
    if (!parsed?.serviceOwned) continue;
    const existing = owners.get(parsed.owner);
    if (existing) existing.push(parsed.name);
    else owners.set(parsed.owner, [parsed.name]);
  }

  return Object.freeze(
    [...owners].map(([owner, capabilities]) =>
      Object.freeze({ owner, capabilities: Object.freeze(capabilities.sort()) }),
    ),
  );
}

/** True when this service exists to extend another. */
export function isServiceExtension(service: {
  capabilities?: readonly string[];
}): boolean {
  return serviceExtensionPoints(service).length > 0;
}

/** The owners this service extends, as plain names. */
export function serviceExtensionOwners(service: {
  capabilities?: readonly string[];
}): readonly string[] {
  return serviceExtensionPoints(service).map((point) => point.owner);
}

/**
 * The same owner written with the other scope marker.
 *
 * A capability owner may be a bare service name (`zelavis/identity`) or a
 * package (`@acme/shop`), and both are legal — which means `@zelavis/identity`
 * is a perfectly valid owner that simply nobody is. The two differ by one
 * character and never match, so declaring the wrong one puts an extension in a
 * catalogue nothing reads rather than producing an error.
 */
const scopeToggled = (owner: string): string =>
  owner.startsWith("@") ? owner.slice(1) : `@${owner}`;

export interface MisscopedExtensionOwner {
  /** The owner as declared. */
  readonly declared: string;
  /** The known service it differs from by its scope marker alone. */
  readonly intended: string;
  readonly capabilities: readonly string[];
}

/**
 * Extension points that name nobody, but would name someone with the `@` moved.
 *
 * Deliberately narrower than "this owner is unknown". A plugin may legitimately
 * extend a service that is not installed here, and an unknown owner is the
 * ordinary way that looks — reporting those would be noise that buries this.
 * An owner that becomes a real service by adding or removing its scope marker
 * is not waiting for anything: it is a mistake, and the only reason it is worth
 * a message is that its symptom otherwise is silence.
 */
export function misscopedExtensionOwners(
  service: { capabilities?: readonly string[] },
  knownServiceNames: ReadonlySet<string>,
): readonly MisscopedExtensionOwner[] {
  const out: MisscopedExtensionOwner[] = [];
  for (const point of serviceExtensionPoints(service)) {
    if (knownServiceNames.has(point.owner)) continue;
    const intended = scopeToggled(point.owner);
    if (!knownServiceNames.has(intended)) continue;
    out.push(
      Object.freeze({
        declared: point.owner,
        intended,
        capabilities: point.capabilities,
      }),
    );
  }
  return Object.freeze(out);
}
