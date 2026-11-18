/** Runtime-neutral registrar capability. Built-in drivers come from the host adapter; plugins extend it. */
import type { ZelavisServiceRegistryEntry } from "../service.js";
import type { DnsProviderCredentialField } from "./dns-provider.js";
export const REGISTRAR_CAPABILITY = "zelavis/edge:registrar";
export interface RegistrarContact {
  readonly firstName: string; readonly lastName: string; readonly organization?: string;
  readonly address1: string; readonly address2?: string; readonly city: string; readonly stateProvince: string;
  readonly postalCode: string; readonly country: string; readonly phone: string; readonly email: string;
}
/** Total for the requested duration, as a decimal string (never floating-point arithmetic). */
export interface RegistrarPrice { readonly amount: string; readonly currency: string; readonly years: number }
export type RegistrarAction = "register" | "renew" | "transfer";
export interface RegistrarAvailability { readonly domain: string; readonly available: boolean; readonly premium: boolean; readonly price?: RegistrarPrice }
export interface RegistrarDomain { readonly owned: boolean; readonly expiresAt?: string; readonly nameservers?: readonly string[] }
export interface RegistrarClient {
  check(domains: readonly string[]): Promise<readonly RegistrarAvailability[]>;
  price(tld: string, action: RegistrarAction, years: number): Promise<RegistrarPrice>;
  /** A domain-specific quote, including premium pricing and registry fees. */
  quote(domain: string, action: RegistrarAction, years: number): Promise<RegistrarPrice>;
  register(input: { domain: string; years: number; contact: RegistrarContact; nameservers?: readonly string[]; confirm: RegistrarPrice }): Promise<{ registrarOrderId: string; chargedAmount?: string }>;
  renew(input: { domain: string; years: number; confirm: RegistrarPrice }): Promise<{ registrarOrderId: string; expiresAt?: string }>;
  transfer(input: { domain: string; years: number; authCode: string; confirm: RegistrarPrice }): Promise<{ transferId: string }>;
  transferStatus(transferId: string): Promise<{ state: "pending" | "completed" | "failed"; detail?: string }>;
  domain(domain: string): Promise<RegistrarDomain>;
  domains(page: { cursor?: string }): Promise<{ domains: readonly { domain: string; expiresAt?: string }[]; next?: string }>;
  setNameservers(domain: string, nameservers: readonly string[]): Promise<void>;
}
export interface RegistrarDefinition {
  readonly name: string; readonly title: string; readonly credentials: readonly DnsProviderCredentialField[];
  readonly tokenGuidance: string;
  createClient(credentials: Readonly<Record<string, string>>, context: { readonly fetch: typeof fetch; readonly signal?: AbortSignal; readonly sandbox: boolean }): RegistrarClient;
}
export interface RegistrarListing { readonly definition: RegistrarDefinition; readonly source: "built-in" | "plugin"; readonly plugin?: string }
export interface RegistrarRefusal { readonly plugin: string; readonly name: string; readonly code: "registrar_conflict" | "registrar_invalid" }

const NAME = /^[a-z][a-z0-9-]{1,31}$/u;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,31}$/u;

const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A definition is data plus one function; anything else is refused rather than half-used. */
export function isRegistrarDefinition(value: unknown): value is RegistrarDefinition {
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

export function defineRegistrars(name: string, providers: readonly RegistrarDefinition[]) {
  if (providers.length === 0 || providers.some((provider) => !isRegistrarDefinition(provider)) ||
      new Set(providers.map((provider) => provider.name)).size !== providers.length) {
    throw new TypeError(`${name} must define registrars with unique names, credential fields and a client factory.`);
  }
  return Object.freeze({
    name,
    kind: "plugin" as const,
    capabilities: [REGISTRAR_CAPABILITY] as readonly string[],
    service: { registrars: [...providers] as readonly RegistrarDefinition[] },
  });
}

/**
 * Built-in providers first, then those of installed plugins declaring `zelavis/edge:registrar`. A plugin provider named
 * like one already listed is refused (`registrar_conflict`): a plugin never shadows a built-in driver.
 */
export function collectRegistrars<T>(
  registry: ReadonlyArray<Readonly<ZelavisServiceRegistryEntry<T>>>,
  builtIn: readonly RegistrarDefinition[] = [],
): { readonly providers: readonly RegistrarListing[]; readonly refused: readonly RegistrarRefusal[] } {
  const providers: RegistrarListing[] = [];
  const refused: RegistrarRefusal[] = [];
  const names = new Set<string>();
  for (const definition of builtIn) {
    if (!isRegistrarDefinition(definition) || names.has(definition.name)) {
      throw new TypeError(`The built-in registrar "${String((definition as { name?: unknown })?.name)}" is invalid or listed twice.`);
    }
    names.add(definition.name);
    providers.push({ definition, source: "built-in" });
  }
  for (const { status, service } of registry) {
    if (status !== "installed" || service.kind !== "plugin" || !service.capabilities?.includes(REGISTRAR_CAPABILITY)) continue;
    const listed = (service.service as { registrars?: unknown } | undefined)?.registrars;
    for (const definition of Array.isArray(listed) ? listed.slice(0, 16) : []) {
      if (!isRegistrarDefinition(definition)) {
        refused.push({ plugin: service.name, name: String((definition as { name?: unknown })?.name ?? ""), code: "registrar_invalid" });
        continue;
      }
      if (names.has(definition.name)) {
        refused.push({ plugin: service.name, name: definition.name, code: "registrar_conflict" });
        continue;
      }
      names.add(definition.name);
      providers.push({ definition, source: "plugin", plugin: service.name });
    }
  }
  return { providers, refused };
}
