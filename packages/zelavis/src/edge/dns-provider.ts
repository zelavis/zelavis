/**
 * The DNS provider contract of Zelavis Edge.
 *
 * Core owns the contract; first-party drivers (Cloudflare) live behind the adapter boundary and are handed to the
 * composition by the host adapter, and a plugin adds another by declaring `zelavis/edge:dns` and exporting
 * `service.dnsProviders`. A driver supplies behavior; the operator supplies credentials, which the Platform keeps
 * encrypted and passes only into `createClient`. Runtime-neutral: no host import, no adapter import.
 */
import type { ZelavisServiceRegistryEntry } from "../service.js";

export const DNS_PROVIDER_CAPABILITY = "zelavis/edge:dns";

export interface DnsProviderCredentialField {
  readonly name: string;
  readonly label: string;
  readonly secret: boolean;
}
export interface DnsProviderZone {
  readonly id: string;
  readonly apex: string;
}
export type DnsProviderRecordType = "A" | "AAAA" | "TXT" | "CNAME";
export interface DnsProviderRecord {
  readonly id: string;
  /** The fully qualified record name, lower case, without a trailing dot. */
  readonly name: string;
  readonly type: DnsProviderRecordType;
  readonly content: string;
  readonly ttl: number;
}
export interface DnsProviderClient {
  zones(page: { readonly cursor?: string }): Promise<{ readonly zones: readonly DnsProviderZone[]; readonly next?: string }>;
  records(zoneId: string, query: { readonly name: string; readonly type: DnsProviderRecordType }): Promise<readonly DnsProviderRecord[]>;
  create(zoneId: string, record: Omit<DnsProviderRecord, "id">): Promise<DnsProviderRecord>;
  /** Idempotent: a record that is already gone is success. */
  remove(zoneId: string, recordId: string): Promise<void>;
}
export interface DnsProviderContext {
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal;
}
export interface DnsProviderDefinition {
  /** `^[a-z][a-z0-9-]{1,31}$`, unique across built-in and plugin providers. */
  readonly name: string;
  readonly title: string;
  readonly credentials: readonly DnsProviderCredentialField[];
  /** What a token can do, shown where the operator pastes it. */
  readonly tokenGuidance: string;
  createClient(credentials: Readonly<Record<string, string>>, context: DnsProviderContext): DnsProviderClient;
}
export interface DnsProviderListing {
  readonly definition: DnsProviderDefinition;
  readonly source: "built-in" | "plugin";
  readonly plugin?: string;
}
export interface DnsProviderRefusal {
  readonly plugin: string;
  readonly name: string;
  readonly code: "dns_provider_conflict" | "dns_provider_invalid";
}

/**
 * TXT answers read from every authoritative server of the zone holding `name`, one list per server, so a DNS-01
 * challenge is only notified once each of them serves the value. Supplied by the host (the Node adapter's
 * authoritative resolver); refused as a whole when any server does not answer authoritatively.
 */
export interface DnsAuthoritativeTxt {
  txtAtEveryAuthority(name: string, signal?: AbortSignal): Promise<readonly (readonly (readonly string[])[])[]>;
}

const NAME = /^[a-z][a-z0-9-]{1,31}$/u;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A definition is data plus one function; anything else is refused rather than half-used. */
export function isDnsProviderDefinition(value: unknown): value is DnsProviderDefinition {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  const credentials = candidate.credentials;
  return text(candidate.name, 32) && NAME.test(candidate.name) && text(candidate.title, 80) && text(candidate.tokenGuidance, 600) &&
    typeof candidate.createClient === "function" && Array.isArray(credentials) && credentials.length > 0 && credentials.length <= 8 &&
    credentials.every((field: unknown) => typeof field === "object" && field !== null &&
      text((field as Record<string, unknown>).name, 32) && FIELD.test((field as Record<string, string>).name) &&
      text((field as Record<string, unknown>).label, 80) && typeof (field as Record<string, unknown>).secret === "boolean") &&
    new Set(credentials.map((field: { name: string }) => field.name)).size === credentials.length;
}

export function defineDnsProviders(name: string, providers: readonly DnsProviderDefinition[]) {
  if (providers.length === 0 || providers.some((provider) => !isDnsProviderDefinition(provider)) ||
      new Set(providers.map((provider) => provider.name)).size !== providers.length) {
    throw new TypeError(`${name} must define DNS providers with unique names, credential fields and a client factory.`);
  }
  return Object.freeze({
    name,
    kind: "plugin" as const,
    capabilities: [DNS_PROVIDER_CAPABILITY] as readonly string[],
    service: { dnsProviders: [...providers] as readonly DnsProviderDefinition[] },
  });
}

/**
 * Built-in providers first, then those of installed plugins declaring `zelavis/edge:dns`. A plugin provider named
 * like one already listed is refused (`dns_provider_conflict`): a plugin never shadows a built-in driver.
 */
export function collectDnsProviders<T>(
  registry: ReadonlyArray<Readonly<ZelavisServiceRegistryEntry<T>>>,
  builtIn: readonly DnsProviderDefinition[] = [],
): { readonly providers: readonly DnsProviderListing[]; readonly refused: readonly DnsProviderRefusal[] } {
  const providers: DnsProviderListing[] = [];
  const refused: DnsProviderRefusal[] = [];
  const names = new Set<string>();
  for (const definition of builtIn) {
    if (!isDnsProviderDefinition(definition) || names.has(definition.name)) {
      throw new TypeError(`The built-in DNS provider "${String((definition as { name?: unknown })?.name)}" is invalid or listed twice.`);
    }
    names.add(definition.name);
    providers.push({ definition, source: "built-in" });
  }
  for (const { status, service } of registry) {
    if (status !== "installed" || service.kind !== "plugin" || !service.capabilities?.includes(DNS_PROVIDER_CAPABILITY)) continue;
    const listed = (service.service as { dnsProviders?: unknown } | undefined)?.dnsProviders;
    for (const definition of Array.isArray(listed) ? listed.slice(0, 16) : []) {
      if (!isDnsProviderDefinition(definition)) {
        refused.push({ plugin: service.name, name: String((definition as { name?: unknown })?.name ?? ""), code: "dns_provider_invalid" });
        continue;
      }
      if (names.has(definition.name)) {
        refused.push({ plugin: service.name, name: definition.name, code: "dns_provider_conflict" });
        continue;
      }
      names.add(definition.name);
      providers.push({ definition, source: "plugin", plugin: service.name });
    }
  }
  return { providers, refused };
}
