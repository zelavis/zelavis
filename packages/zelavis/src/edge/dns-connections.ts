/**
 * Operator DNS connections and adopted zones: Platform Edge authority in the System Store.
 *
 * A connection is one provider's credentials, encrypted with a key bound to that provider and never returned. An
 * adopted zone is an apex the operator chose from a connection's zones, with whether customers may take a hosted
 * subdomain one label below it and the addresses those subdomains point at. Every provider call goes through
 * `call`: at most four in flight per provider, ten seconds each, and one `edge.dns.call` log line naming the
 * provider, the operation, the zone apex and the outcome, never a credential.
 */
import { Data, Effect, Schema, Semaphore } from "effect";
import { evaluate, integration, present, unwrapFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import type { ZelavisSystemStore, ZelavisSystemStoreRecord, ZelavisSystemStoreValue } from "../system-store.js";
import { decryptSecret, encryptSecret } from "./acme-crypto.js";
import type { DnsProviderClient, DnsProviderListing, DnsProviderRecordType, DnsProviderZone } from "./dns-provider.js";
import { normalizeProjectDomainHostname } from "./project-domains.js";

export const DNS_CONNECTIONS_NAMESPACE = "edge.dns-connections";
export const DNS_ZONES_NAMESPACE = "edge.dns-zones";
export const MAX_DNS_ZONES = 50;
const MAX_ZONE_PAGES = 20;
const PERMITS_PER_PROVIDER = 4;

export type EdgeDnsErrorCode = "invalid_dns_connection" | "hosted_zone_unavailable" | "dns_zone_not_found" |
  "dns_revision_conflict" | "dns_in_use" | "dns_zone_limit" | "dns_provider_failed" | "dns_provider_unavailable";
export const EDGE_DNS_STATUSES: Readonly<Record<EdgeDnsErrorCode, number>> = {
  invalid_dns_connection: 400, hosted_zone_unavailable: 400, dns_zone_not_found: 404, dns_revision_conflict: 409,
  dns_in_use: 409, dns_zone_limit: 429, dns_provider_failed: 502, dns_provider_unavailable: 503,
};
export class EdgeDnsError extends Data.TaggedError("EdgeDnsError")<{ readonly code: EdgeDnsErrorCode; readonly message: string }> {}
const failure = (code: EdgeDnsErrorCode, message: string) => new EdgeDnsError({ code, message });

const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])$/u;
const isIpv6 = (value: string) => {
  if (!/^[0-9a-f:.]{2,45}$/iu.test(value) || !value.includes(":")) return false;
  try { return new URL(`http://[${value}]/`).hostname.length > 2; } catch { return false; }
};
const Timestamp = Schema.String.check(Schema.isMaxLength(40));
const Secret = Schema.Struct({ ciphertext: Schema.String, iv: Schema.String, tag: Schema.String, algorithm: Schema.Literal("AES-256-GCM") });
const StoredConnection = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  provider: Schema.String,
  credentials: Secret,
  revision: Schema.Natural,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
const Targets = Schema.Struct({
  a: Schema.Array(Schema.String.check(Schema.isPattern(ipv4))).check(Schema.isMaxLength(2)),
  aaaa: Schema.Array(Schema.String.check(Schema.makeFilter(isIpv6))).check(Schema.isMaxLength(2)),
  cname: Schema.optionalKey(Schema.String.check(Schema.makeFilter(value => normalizeProjectDomainHostname(value) === value))),
}).check(Schema.makeFilter(({ a, aaaa, cname }) => cname === undefined || (a.length === 0 && aaaa.length === 0)));
const Apex = Schema.String.check(Schema.makeFilter(value => normalizeProjectDomainHostname(value) === value));
const StoredZone = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  apex: Apex,
  provider: Schema.String,
  zoneId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u)),
  hostedSubdomains: Schema.Boolean,
  targets: Targets,
  wildcardCertificateRef: Schema.optionalKey(Schema.String),
  revision: Schema.Natural,
  updatedAt: Timestamp,
});
export type EdgeDnsZone = typeof StoredZone.Type;
const strict = { onExcessProperty: "error" } as const;
const decodeConnection = Schema.decodeUnknownSync(StoredConnection);
const decodeZone = Schema.decodeUnknownSync(StoredZone);

export const ConnectDnsProviderSchema = Schema.Struct({
  credentials: Schema.Record(Schema.String.check(Schema.isMaxLength(32)), Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1024))),
  expectedRevision: Schema.optionalKey(Schema.Natural),
});
export const AdoptDnsZoneSchema = Schema.Struct({
  provider: Schema.String.check(Schema.isMaxLength(32)),
  zoneId: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/u)),
  hostedSubdomains: Schema.Boolean,
  targets: Targets,
  expectedRevision: Schema.optionalKey(Schema.Natural),
});
export const decodeConnectDnsProvider = Schema.decodeUnknownSync(ConnectDnsProviderSchema, strict);
export const decodeAdoptDnsZone = Schema.decodeUnknownSync(AdoptDnsZoneSchema, strict);
export type ConnectDnsProviderInput = typeof ConnectDnsProviderSchema.Type;
export type AdoptDnsZoneInput = typeof AdoptDnsZoneSchema.Type;

export interface EdgeDnsProviderSummary {
  readonly name: string;
  readonly title: string;
  readonly source: "built-in" | "plugin";
  readonly plugin?: string;
  readonly credentials: readonly { readonly name: string; readonly label: string; readonly secret: boolean }[];
  readonly tokenGuidance: string;
  readonly connected: boolean;
  readonly revision?: number;
}
export interface EdgeDnsZoneSummary {
  readonly apex: string;
  readonly provider: string;
  readonly zoneId: string;
  readonly hostedSubdomains: boolean;
  readonly targets: EdgeDnsZone["targets"];
  readonly wildcardCertificateRef?: string;
  readonly revision: number;
  readonly updatedAt: string;
}
/** A record Zelavis created, named by the provider's id so it is removed by exactly that id. */
export interface DnsRecordRef {
  readonly provider: string;
  readonly zoneId: string;
  readonly recordId: string;
  readonly type: DnsProviderRecordType;
}

/** The address records a hosted subdomain gets from its zone: A and AAAA, or one CNAME; at most four. */
export function hostedRecordsFor(zone: EdgeDnsZone): readonly { readonly type: "A" | "AAAA" | "CNAME"; readonly content: string }[] {
  if (zone.targets.cname) return [{ type: "CNAME", content: zone.targets.cname }];
  return [...zone.targets.a.map(content => ({ type: "A" as const, content })), ...zone.targets.aaaa.map(content => ({ type: "AAAA" as const, content }))];
}

/** What certificates and Project domains use. Not an HTTP surface. */
export interface EdgeDnsAccess {
  /** The adopted zone with the longest apex covering `name` (the apex itself or below it). */
  zoneFor(name: string): Effect.Effect<EdgeDnsZone | undefined, TaggedFailure>;
  /** The zone `hostname` is exactly one label below, when it allows hosted subdomains. */
  hostedZoneFor(hostname: string): Effect.Effect<EdgeDnsZone | undefined, TaggedFailure>;
  createRecord(zone: EdgeDnsZone, record: { readonly name: string; readonly type: DnsProviderRecordType; readonly content: string; readonly ttl: number }):
    Effect.Effect<DnsRecordRef, TaggedFailure>;
  removeRecord(ref: DnsRecordRef, apex: string): Effect.Effect<void, TaggedFailure>;
  /** A record at `name` holding exactly `content`, created earlier by Zelavis but whose id was never recorded. */
  findRecord(zone: EdgeDnsZone, record: { readonly name: string; readonly type: DnsProviderRecordType; readonly content: string }):
    Effect.Effect<DnsRecordRef | undefined, TaggedFailure>;
  /** Removes the records at `name` holding exactly `content`: cleanup for a create whose id was never recorded. */
  removeMatching(target: { readonly provider: string; readonly zoneId: string; readonly apex: string },
    record: { readonly name: string; readonly type: DnsProviderRecordType; readonly content: string }): Effect.Effect<number, TaggedFailure>;
  setWildcardCertificate(apex: string, ref: string): Effect.Effect<void, TaggedFailure>;
  hostedApexes(): Effect.Effect<readonly string[], TaggedFailure>;
}

export interface EdgeDnsController {
  providers(): Promise<{ readonly providers: readonly EdgeDnsProviderSummary[] }>;
  connect(provider: string, input: ConnectDnsProviderInput): Promise<{ readonly provider: string; readonly revision: number; readonly connected: true }>;
  disconnect(provider: string): Promise<void>;
  providerZones(provider: string, cursor?: string): Promise<{ readonly zones: readonly DnsProviderZone[]; readonly next?: string }>;
  zones(): Promise<{ readonly zones: readonly EdgeDnsZoneSummary[] }>;
  zone(apex: string): Promise<EdgeDnsZoneSummary | undefined>;
  adoptZone(apex: string, input: AdoptDnsZoneInput): Promise<EdgeDnsZoneSummary>;
  releaseZone(apex: string): Promise<void>;
  readonly access: EdgeDnsAccess;
}

const summary = (zone: EdgeDnsZone): EdgeDnsZoneSummary => ({
  apex: zone.apex, provider: zone.provider, zoneId: zone.zoneId, hostedSubdomains: zone.hostedSubdomains, targets: zone.targets,
  ...(zone.wildcardCertificateRef ? { wildcardCertificateRef: zone.wildcardCertificateRef } : {}),
  revision: zone.revision, updatedAt: zone.updatedAt,
});

export function createEdgeDnsController(options: {
  readonly store: ZelavisSystemStore;
  readonly masterSecret: string;
  readonly providers: readonly DnsProviderListing[];
  readonly fetch?: typeof fetch;
  /** True while a Project domain depends on the zone; release is refused until then. */
  readonly zoneInUse?: (apex: string) => Effect.Effect<boolean, TaggedFailure>;
  readonly callTimeoutMs?: number;
  readonly now?: () => Date;
}): EdgeDnsController {
  const { store, masterSecret } = options;
  const fetcher = options.fetch ?? globalThis.fetch;
  const callTimeoutMs = options.callTimeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());
  const listings = new Map(options.providers.map(listing => [listing.definition.name, listing]));
  const permits = new Map<string, Semaphore.Semaphore>();
  const permitsFor = (provider: string) => {
    let held = permits.get(provider);
    if (!held) permits.set(provider, held = Semaphore.makeUnsafe(PERMITS_PER_PROVIDER));
    return held;
  };
  const keyFor = (provider: string) => `${masterSecret}\u0000edge.dns:${provider}`;

  const listing = (provider: string) => {
    const found = listings.get(provider);
    return found ? Effect.succeed(found) : Effect.fail(failure("dns_provider_unavailable", `The DNS provider "${provider}" is not installed.`));
  };
  const readConnection = Effect.fn("EdgeDns.readConnection")(function* (provider: string) {
    const record = yield* integration(() => store.get(DNS_CONNECTIONS_NAMESPACE, provider));
    if (!record) return undefined;
    return { record, value: yield* evaluate(() => decodeConnection(record.value)) };
  });
  const readZones = Effect.fn("EdgeDns.readZones")(function* () {
    const records = yield* integration(() => store.list(DNS_ZONES_NAMESPACE));
    return yield* Effect.forEach(records, record => evaluate(() => ({ record, value: decodeZone(record.value) })));
  });
  const readZone = Effect.fn("EdgeDns.readZone")(function* (apex: string) {
    const record = yield* integration(() => store.get(DNS_ZONES_NAMESPACE, apex));
    return record ? { record, value: yield* evaluate(() => decodeZone(record.value)) } : undefined;
  });

  /** One provider call: permit, deadline, audit line; the error says what failed and never repeats a credential. */
  const call = <A>(provider: string, operation: string, apex: string | undefined, use: (client: DnsProviderClient) => Promise<A>) =>
    Effect.gen(function* () {
      const { definition } = yield* listing(provider);
      const connection = yield* readConnection(provider);
      if (!connection) return yield* failure("invalid_dns_connection", `No ${definition.title} connection is configured.`);
      const credentials = yield* evaluate((): Readonly<Record<string, string>> => {
        const decoded: unknown = JSON.parse(decryptSecret(connection.value.credentials, keyFor(provider)));
        return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(decoded);
      });
      return yield* attempt(provider, operation, apex, credentials, use);
    });
  const attempt = <A>(provider: string, operation: string, apex: string | undefined,
    credentials: Readonly<Record<string, string>>, use: (client: DnsProviderClient) => Promise<A>) =>
    Effect.gen(function* () {
      const { definition } = yield* listing(provider);
      const secrets = Object.values(credentials).filter(value => value.length >= 4);
      const clean = (message: string) => secrets.reduce((text, secret) => text.split(secret).join("[credential]"), message).slice(0, 400);
      const outcome = yield* permitsFor(provider).withPermits(1)(
        integration(signal => use(definition.createClient(credentials, { fetch: fetcher, signal })), { interruptible: true }).pipe(
          Effect.timeoutOrElse({
            duration: callTimeoutMs,
            orElse: () => Effect.fail(failure("dns_provider_failed", `${definition.title} did not answer within ${Math.round(callTimeoutMs / 1000)} s.`)),
          }),
          Effect.result,
        ));
      yield* Effect.logInfo("edge.dns.call", { provider, operation, zone: apex ?? null, outcome: outcome._tag === "Success" ? "ok" : "failed" });
      if (outcome._tag === "Success") return outcome.success;
      const error = unwrapFailure(outcome.failure);
      if (error instanceof EdgeDnsError) return yield* error;
      const message = error instanceof Error ? error.message : String(error);
      return yield* failure("dns_provider_failed", `${definition.title} ${operation} failed: ${clean(message)}`);
    });

  const zonesPage = (provider: string, cursor: string | undefined, apex: string | undefined,
    credentials?: Readonly<Record<string, string>>) => {
    if (cursor !== undefined && !/^[A-Za-z0-9._~-]{1,256}$/u.test(cursor)) return Effect.fail(failure("invalid_dns_connection", "The zone page cursor is invalid."));
    const use = (client: DnsProviderClient) => client.zones(cursor === undefined ? {} : { cursor });
    return (credentials ? attempt(provider, "zones", apex, credentials, use) : call(provider, "zones", apex, use)).pipe(
      Effect.flatMap(page => Array.isArray(page?.zones) && page.zones.length <= 500 &&
          page.zones.every(zone => typeof zone?.id === "string" && typeof zone.apex === "string") &&
          (page.next === undefined || typeof page.next === "string")
        ? Effect.succeed({ zones: page.zones.map(zone => ({ id: zone.id, apex: zone.apex })), ...(page.next ? { next: page.next } : {}) })
        : Effect.fail(failure("dns_provider_failed", "The DNS provider answered with an unexpected zone list."))));
  };

  const zoneFor = Effect.fn("EdgeDns.zoneFor")(function* (name: string) {
    const host = name.toLowerCase().replace(/\.$/u, "");
    let best: EdgeDnsZone | undefined;
    for (const { value } of yield* readZones()) {
      if ((host === value.apex || host.endsWith(`.${value.apex}`)) && (!best || value.apex.length > best.apex.length)) best = value;
    }
    return best;
  });

  const access: EdgeDnsAccess = {
    zoneFor,
    hostedZoneFor: Effect.fn("EdgeDns.hostedZoneFor")(function* (hostname: string) {
      const dot = hostname.indexOf(".");
      if (dot <= 0) return undefined;
      const zone = (yield* readZone(hostname.slice(dot + 1)))?.value;
      return zone?.hostedSubdomains ? zone : undefined;
    }),
    createRecord: Effect.fn("EdgeDns.createRecord")(function* (zone, record) {
      const created = yield* call(zone.provider, "create", zone.apex, client => client.create(zone.zoneId, record));
      if (typeof created?.id !== "string" || created.id.length === 0 || created.id.length > 128) {
        return yield* failure("dns_provider_failed", "The DNS provider answered without a record id.");
      }
      return { provider: zone.provider, zoneId: zone.zoneId, recordId: created.id, type: record.type };
    }),
    removeRecord: (ref, apex) => call(ref.provider, "remove", apex, client => client.remove(ref.zoneId, ref.recordId)),
    findRecord: Effect.fn("EdgeDns.findRecord")(function* (zone, record) {
      const found = yield* call(zone.provider, "records", zone.apex, client => client.records(zone.zoneId, { name: record.name, type: record.type }));
      const row = (Array.isArray(found) ? found : []).find(entry => entry?.content === record.content && typeof entry.id === "string" && entry.id.length <= 128);
      return row ? { provider: zone.provider, zoneId: zone.zoneId, recordId: row.id, type: record.type } : undefined;
    }),
    removeMatching: Effect.fn("EdgeDns.removeMatching")(function* (target, record) {
      const found = yield* call(target.provider, "records", target.apex, client => client.records(target.zoneId, { name: record.name, type: record.type }));
      const matching = (Array.isArray(found) ? found : []).filter(row => row?.content === record.content && typeof row.id === "string").slice(0, 16);
      for (const row of matching) yield* call(target.provider, "remove", target.apex, client => client.remove(target.zoneId, row.id));
      return matching.length;
    }),
    setWildcardCertificate: Effect.fn("EdgeDns.setWildcardCertificate")(function* (apex: string, ref: string) {
      for (let round = 0; round < 4; round++) {
        const current = yield* readZone(apex);
        if (!current) return yield* failure("dns_zone_not_found", `The zone ${apex} is not adopted.`);
        if (current.value.wildcardCertificateRef === ref) return;
        const next = { ...current.value, wildcardCertificateRef: ref, revision: current.value.revision + 1, updatedAt: now().toISOString() };
        if (yield* integration(() => store.compareAndSet(DNS_ZONES_NAMESPACE, apex, current.record.updatedAt, next as unknown as ZelavisSystemStoreValue, current.record.value))) return;
      }
      return yield* failure("dns_revision_conflict", "The zone changed while its wildcard certificate was recorded.");
    }),
    hostedApexes: () => readZones().pipe(Effect.map(zones => zones.filter(({ value }) => value.hostedSubdomains).map(({ value }) => value.apex).sort())),
  };

  const apexOf = (raw: string) => {
    const apex = normalizeProjectDomainHostname(raw);
    return apex ? Effect.succeed(apex) : Effect.fail(failure("dns_zone_not_found", "Enter an exact zone apex."));
  };
  const conflict = () => failure("dns_revision_conflict", "The DNS setting changed. Refresh and retry.");
  const saveCas = (namespace: string, key: string, observed: ZelavisSystemStoreRecord | undefined, value: unknown) =>
    Effect.gen(function* () {
      const stored = value as ZelavisSystemStoreValue;
      const saved = observed
        ? yield* integration(() => store.compareAndSet(namespace, key, observed.updatedAt, stored, observed.value))
        : (yield* integration(() => store.setIfAbsent(namespace, key, stored))).created;
      if (!saved) return yield* conflict();
    });

  return {
    access,
    providers: () => present(Effect.gen(function* () {
      const providers = yield* Effect.forEach(options.providers, ({ definition, source, plugin }) => Effect.gen(function* () {
        const connection = yield* readConnection(definition.name);
        return {
          name: definition.name, title: definition.title, source, ...(plugin ? { plugin } : {}),
          credentials: definition.credentials.map(({ name, label, secret }) => ({ name, label, secret })),
          tokenGuidance: definition.tokenGuidance, connected: Boolean(connection),
          ...(connection ? { revision: connection.value.revision } : {}),
        };
      }), { concurrency: 4 });
      return { providers };
    })),
    connect: (provider, input) => present(Effect.gen(function* () {
      const { definition } = yield* listing(provider);
      const names = Object.keys(input.credentials).sort();
      const expected = definition.credentials.map(field => field.name).sort();
      if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
        return yield* failure("invalid_dns_connection", `${definition.title} needs exactly: ${expected.join(", ")}.`);
      }
      const existing = yield* readConnection(provider);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (existing?.value.revision ?? 0)) return yield* conflict();
      // The credentials must reach the provider before they are kept.
      yield* zonesPage(provider, undefined, undefined, input.credentials);
      const time = now().toISOString();
      const revision = (existing?.value.revision ?? 0) + 1;
      yield* saveCas(DNS_CONNECTIONS_NAMESPACE, provider, existing?.record, {
        schemaVersion: 1, provider, credentials: { ...encryptSecret(JSON.stringify(input.credentials), keyFor(provider)) },
        revision, createdAt: existing?.value.createdAt ?? time, updatedAt: time,
      });
      yield* Effect.logInfo("edge.dns.connection", { provider, action: "connect", revision });
      return { provider, revision, connected: true as const };
    })),
    disconnect: provider => present(Effect.gen(function* () {
      yield* listing(provider);
      const existing = yield* readConnection(provider);
      if (!existing) return;
      if ((yield* readZones()).some(({ value }) => value.provider === provider)) {
        return yield* failure("dns_in_use", "Release the zones adopted through this connection first.");
      }
      if (!(yield* integration(() => store.compareAndDelete(DNS_CONNECTIONS_NAMESPACE, provider, existing.record.updatedAt, existing.record.value)))) {
        return yield* conflict();
      }
      yield* Effect.logInfo("edge.dns.connection", { provider, action: "disconnect" });
    })),
    providerZones: (provider, cursor) => present(zonesPage(provider, cursor, undefined)),
    zones: () => present(readZones().pipe(Effect.map(zones => ({
      zones: zones.map(({ value }) => summary(value)).sort((a, b) => (a.apex < b.apex ? -1 : a.apex > b.apex ? 1 : 0)),
    })))),
    zone: raw => present(Effect.gen(function* () {
      const apex = normalizeProjectDomainHostname(raw);
      const found = apex ? yield* readZone(apex) : undefined;
      return found ? summary(found.value) : undefined;
    })),
    adoptZone: (raw, input) => present(Effect.gen(function* () {
      const apex = yield* apexOf(raw);
      yield* listing(input.provider);
      if (input.hostedSubdomains && input.targets.a.length + input.targets.aaaa.length === 0 && input.targets.cname === undefined) {
        return yield* failure("hosted_zone_unavailable", "Hosted subdomains need an IPv4, IPv6 or CNAME target.");
      }
      const existing = yield* readZone(apex);
      if (input.expectedRevision !== undefined && input.expectedRevision !== (existing?.value.revision ?? 0)) return yield* conflict();
      if (existing && (existing.value.provider !== input.provider || existing.value.zoneId !== input.zoneId) &&
          (yield* (options.zoneInUse?.(apex) ?? Effect.succeed(false)))) {
        return yield* failure("dns_in_use", "Project domains use this zone; release them before moving it to another provider zone.");
      }
      if (!existing && (yield* integration(() => store.list(DNS_ZONES_NAMESPACE))).length >= MAX_DNS_ZONES) {
        return yield* failure("dns_zone_limit", `At most ${MAX_DNS_ZONES} zones can be adopted.`);
      }
      // The provider zone must exist in this connection and contain the apex.
      let found: DnsProviderZone | undefined;
      let cursor: string | undefined;
      for (let page = 0; page < MAX_ZONE_PAGES && !found; page++) {
        const listed = yield* zonesPage(input.provider, cursor, apex);
        found = listed.zones.find(zone => zone.id === input.zoneId);
        cursor = listed.next;
        if (!cursor) break;
      }
      if (!found || !(apex === found.apex || apex.endsWith(`.${found.apex}`))) {
        return yield* failure("dns_zone_not_found", `The provider zone does not exist in this connection or does not contain ${apex}.`);
      }
      const zone: EdgeDnsZone = {
        schemaVersion: 1, apex, provider: input.provider, zoneId: input.zoneId, hostedSubdomains: input.hostedSubdomains,
        targets: { a: [...input.targets.a], aaaa: [...input.targets.aaaa], ...(input.targets.cname ? { cname: input.targets.cname } : {}) },
        ...(existing?.value.wildcardCertificateRef && existing.value.provider === input.provider
          ? { wildcardCertificateRef: existing.value.wildcardCertificateRef } : {}),
        revision: (existing?.value.revision ?? 0) + 1, updatedAt: now().toISOString(),
      };
      yield* saveCas(DNS_ZONES_NAMESPACE, apex, existing?.record, zone);
      yield* Effect.logInfo("edge.dns.zone", { apex, provider: input.provider, action: "adopt", revision: zone.revision });
      return summary(zone);
    })),
    releaseZone: raw => present(Effect.gen(function* () {
      const apex = yield* apexOf(raw);
      const existing = yield* readZone(apex);
      if (!existing) return yield* failure("dns_zone_not_found", `The zone ${apex} is not adopted.`);
      if (yield* (options.zoneInUse?.(apex) ?? Effect.succeed(false))) {
        return yield* failure("dns_in_use", "Project domains use this zone; remove them first.");
      }
      if (!(yield* integration(() => store.compareAndDelete(DNS_ZONES_NAMESPACE, apex, existing.record.updatedAt, existing.record.value)))) {
        return yield* conflict();
      }
      yield* Effect.logInfo("edge.dns.zone", { apex, provider: existing.value.provider, action: "release" });
    })),
  };
}
