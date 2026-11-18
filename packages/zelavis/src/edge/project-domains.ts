import { Data, Effect, Schema, Semaphore } from "effect";
import { describeFailure, evaluate, integration, present, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { generateVerificationToken } from "../domain-binding.js";
import { checkDomainBindingDnsProof, domainBindingDnsChallengeName, DnsTxtProofMissing, type DnsTxtResolver } from "../domain-verifier.js";
import { isCanonicalProjectId, ZelavisProjectConflictError, ZelavisProjectNotFoundError, type ZelavisProjectManager } from "../project.js";
import type { ZelavisSystemStore } from "../system-store.js";
import type { ZelavisCertificateController } from "./certificates.js";
import { EdgeDnsError, hostedRecordsFor, type EdgeDnsAccess } from "./dns-connections.js";
import type { ZelavisEdgeManager } from "./index.js";
import { projectDomainRouteId, toPublicationSummary, type ProjectHostnameOwner, type ZelavisEdgeRouteStore } from "./routes.js";

export const PROJECT_DOMAINS_NAMESPACE = "edge.project-domains.v1";
export const PROJECT_DOMAIN_PROBE_PATH = "/.well-known/zelavis-project-domain";
const MAX_DOMAINS = 20;
const CHALLENGE_MS = 24 * 60 * 60 * 1000;
const PROOF_MS = 60_000;
const RETRY_MS = 30_000;

export const PROJECT_DOMAINS_VIEW = "project.domains.view";
export const PROJECT_DOMAINS_MANAGE = "project.domains.manage";

export function isProjectDomainLoopbackTarget(target: string): boolean {
  const port = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(target)?.[1];
  return port !== undefined && Number(port) > 0 && Number(port) <= 65_535;
}

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const reservedSuffixes = new Set(["local", "localhost", "internal", "lan", "localdomain", "home", "onion", "invalid", "test"]);

export function normalizeProjectDomainHostname(raw: string): string | undefined {
  if (raw.length > 254 || !/^[a-z0-9.-]+$/i.test(raw)) return undefined;
  const host = raw.toLowerCase().replace(/\.$/, "");
  const labels = host.split(".");
  const suffix = labels[labels.length - 1]!;
  if (host.length > 253 || labels.length < 2 || !labels.every(part => label.test(part)) ||
      !/[a-z]/.test(suffix) || reservedSuffixes.has(suffix) ||
      /^(?:0x[0-9a-f]+|[0-9]+)$/.test(suffix) || host === "home.arpa" || host.endsWith(".home.arpa")) return undefined;
  try {
    // The URL implementation validates ASCII IDNA labels and rejects IP spellings.
    return new URL(`https://${host}/`).hostname === host ? host : undefined;
  } catch {
    return undefined;
  }
}

const tlsMode = Schema.Literals(["external", "managed"]);
const dnsMode = Schema.Literals(["manual", "automatic"]);
const MAX_DNS_RECORDS = 4;
const storedRecord = Schema.Struct({
  provider: Schema.String.check(Schema.isMaxLength(32)),
  zoneId: Schema.String.check(Schema.isMaxLength(128)),
  recordId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  type: Schema.Literals(["A", "AAAA", "CNAME"]),
  content: Schema.String.check(Schema.isMaxLength(253)),
});
const state = Schema.Literals(["pending_dns", "verified", "publishing", "active", "removing"]);
const issue = Schema.Literals(["dns_pending", "dns_unavailable", "edge_unavailable", "certificate_pending", "publication_pending"]);
const timestamp = Schema.String.check(Schema.makeFilter(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}));
const storedEntry = Schema.Struct({
  id: Schema.String.check(Schema.isUUID(4)),
  hostname: Schema.String.check(Schema.makeFilter(value => normalizeProjectDomainHostname(value) === value)),
  tlsMode,
  state,
  revision: Schema.Natural,
  createdAt: timestamp,
  updatedAt: timestamp,
  challengeToken: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{32,128}$/))),
  challengeExpiresAt: Schema.optionalKey(timestamp),
  lastCheckedAt: Schema.optionalKey(timestamp),
  verifiedAt: Schema.optionalKey(timestamp),
  activatedAt: Schema.optionalKey(timestamp),
  publicationRevision: Schema.optionalKey(Schema.Natural),
  stagedRoute: Schema.optionalKey(Schema.Literal(true)),
  issue: Schema.optionalKey(issue),
  /** Absent is manual: the customer proves the hostname with a TXT record. Automatic is a hosted subdomain. */
  dns: Schema.optionalKey(dnsMode),
  dnsRecords: Schema.optionalKey(Schema.Array(storedRecord).check(Schema.isMaxLength(MAX_DNS_RECORDS))),
}).check(Schema.makeFilter(entry => {
  if (entry.dns === "automatic" && (entry.tlsMode !== "managed" || entry.state === "pending_dns" || entry.challengeToken)) return false;
  if (entry.dns !== "automatic" && entry.dnsRecords) return false;
  if (entry.state === "pending_dns") return Boolean(entry.challengeToken && entry.challengeExpiresAt && !entry.verifiedAt);
  if (entry.state === "removing") return true;
  return Boolean(entry.verifiedAt && (entry.state !== "active" || entry.activatedAt));
}));

const strict = { onExcessProperty: "error" } as const;
const decodeStore = Schema.decodeUnknownSync(Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revision: Schema.Natural,
  entries: Schema.Array(storedEntry).check(Schema.isMaxLength(MAX_DOMAINS)),
}).check(Schema.makeFilter(({ entries, revision }) =>
  entries.every(entry => entry.revision <= revision) &&
  new Set(entries.map(entry => entry.hostname)).size === entries.length &&
  new Set(entries.map(entry => entry.id)).size === entries.length)), strict);
type StoredDomain = typeof storedEntry.Type;

export const AddProjectDomainSchema = Schema.Struct({
  hostname: Schema.String.check(Schema.isMaxLength(254)),
  tlsMode,
  /** `automatic`: a subdomain one label below an operator zone that allows hosted subdomains; managed TLS only. */
  dns: Schema.optionalKey(dnsMode),
});
export const VerifyProjectDomainSchema = Schema.Struct({ expectedRevision: Schema.Natural });
export const decodeAddProjectDomain = Schema.decodeUnknownSync(AddProjectDomainSchema, strict);
export const decodeVerifyProjectDomain = Schema.decodeUnknownSync(VerifyProjectDomainSchema, strict);
export type AddProjectDomainInput = typeof AddProjectDomainSchema.Type;
export type VerifyProjectDomainInput = typeof VerifyProjectDomainSchema.Type;
export type ProjectDomainTlsMode = typeof tlsMode.Type;
export type ProjectDomainState = typeof state.Type;
export type ProjectDomainDnsMode = typeof dnsMode.Type;

export interface ProjectDomain {
  readonly id: string;
  readonly projectId: string;
  readonly hostname: string;
  readonly tlsMode: ProjectDomainTlsMode;
  readonly dns: ProjectDomainDnsMode;
  readonly state: ProjectDomainState;
  readonly revision: number;
  readonly verifiedAt?: string;
  readonly publicUrl?: string;
  readonly challenge?: { readonly name: string; readonly value: string; readonly expiresAt: string };
  readonly issue?: typeof issue.Type;
}
export interface ProjectDomainList { readonly domains: readonly ProjectDomain[] }
export interface ProjectHostedZones { readonly zones: readonly { readonly apex: string }[] }
export interface RemoveProjectDomainResult { readonly removed: boolean; readonly pending: boolean }

/** Configured by the Platform host. The public request cannot set an ingress target. */
export interface ProjectDomainIngress {
  readonly dns: DnsTxtResolver;
  readonly externalTarget?: string;
  readonly preflight?: (hostname: string) => Promise<boolean>;
  readonly probe?: (hostname: string, tlsMode: ProjectDomainTlsMode) => Promise<boolean>;
  readonly probeWithdrawal?: (hostname: string) => Promise<boolean>;
}

type DomainErrorCode = "invalid_hostname" | "invalid_domain_request" | "domain_not_found" |
  "hostname_unavailable" | "domain_revision_conflict" | "project_deleting" |
  "dns_not_verified" | "domain_limit" | "domain_verification_busy" | "domain_ingress_unavailable" | "hosted_zone_unavailable" |
  "dns_provider_failed";

export class ProjectDomainError extends Data.TaggedError("ProjectDomainError")<{
  readonly code: DomainErrorCode;
  readonly message: string;
  readonly retryAfter?: number;
}> {}

const failure = (code: DomainErrorCode, message: string, retryAfter?: number) =>
  new ProjectDomainError({ code, message, ...(retryAfter === undefined ? {} : { retryAfter }) });
const missing = () => failure("domain_not_found", "The Project domain was not found.");
const conflict = () => failure("domain_revision_conflict", "The domain changed. Refresh its status and retry.");
const unavailable = () => failure("hostname_unavailable", "This hostname is unavailable.");

function presentDomain(projectId: string, entry: StoredDomain): ProjectDomain {
  const { id, hostname, tlsMode, state, revision, verifiedAt, issue, challengeToken, challengeExpiresAt } = entry;
  return {
    id, projectId, hostname, tlsMode, dns: entry.dns ?? "manual", state, revision,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(state === "active" ? { publicUrl: `https://${hostname}/` } : {}),
    ...(state === "pending_dns" && challengeToken && challengeExpiresAt ? {
      challenge: { name: domainBindingDnsChallengeName(hostname), value: challengeToken, expiresAt: challengeExpiresAt },
    } : {}),
    ...(issue ? { issue } : {}),
  };
}

export interface ProjectDomainController {
  list(projectId: string): Promise<ProjectDomainList>;
  add(projectId: string, input: AddProjectDomainInput): Promise<{ domain: ProjectDomain; created: boolean }>;
  verify(projectId: string, hostname: string, input: VerifyProjectDomainInput): Promise<ProjectDomain>;
  remove(projectId: string, hostname: string, expectedRevision: number): Promise<RemoveProjectDomainResult>;
  /** The operator zones a customer may take a hosted subdomain under. */
  hostedZones(projectId: string): Promise<ProjectHostedZones>;
  /** Called by the deletion participant that already holds the Project lifecycle permit. */
  cleanup(projectId: string): Effect.Effect<void, TaggedFailure>;
}

export function createProjectDomainController(options: {
  store: ZelavisSystemStore;
  routes: ZelavisEdgeRouteStore;
  projects: () => Pick<ZelavisProjectManager, "view" | "withLiveProject"> | undefined;
  ingress?: ProjectDomainIngress;
  manager?: ZelavisEdgeManager;
  certificates?: ZelavisCertificateController;
  /** Operator DNS zones: hosted subdomains and their address records. */
  dns?: EdgeDnsAccess;
  now?: () => number;
}): ProjectDomainController {
  const { store, routes, manager, ingress, certificates, dns } = options;
  const now = options.now ?? Date.now;
  const time = () => new Date(now()).toISOString();
  const dnsPermits = Semaphore.makeUnsafe(4);
  const activationPermits = Semaphore.makeUnsafe(4);
  const certificatePermits = Semaphore.makeUnsafe(2);
  const orders = new Map<string, AbortController>();
  const publicationPermit = Semaphore.makeUnsafe(1);

  const normalize = (raw: string) => {
    const host = normalizeProjectDomainHostname(raw);
    if (!host) return Effect.fail(failure("invalid_hostname", "Enter an exact public hostname."));
    if (domainBindingDnsChallengeName(host).length > 253) {
      return Effect.fail(failure("invalid_hostname", "The hostname is too long for its DNS TXT challenge."));
    }
    return Effect.succeed(host);
  };
  const read = Effect.fn("ProjectDomains.read")(function* (projectId: string) {
    const record = yield* integration(() => store.get(PROJECT_DOMAINS_NAMESPACE, projectId));
    const value = record ? yield* evaluate(() => decodeStore(record.value)) : { entries: [], revision: 0 };
    return { record, ...value };
  });
  const save = Effect.fn("ProjectDomains.save")(function* (
    projectId: string, observed: Effect.Success<ReturnType<typeof read>>, entries: readonly StoredDomain[],
  ) {
    const value = { schemaVersion: 1, revision: Math.max(observed.revision, ...entries.map(entry => entry.revision)), entries } as const;
    const { record } = observed;
    const saved = record
      ? yield* integration(() => store.compareAndSet(PROJECT_DOMAINS_NAMESPACE, projectId, record.updatedAt, value, record.value))
      : (yield* integration(() => store.setIfAbsent(PROJECT_DOMAINS_NAMESPACE, projectId, value))).created;
    if (!saved) return yield* conflict();
  });
  const current = Effect.fn("ProjectDomains.current")(function* (projectId: string, hostname: string, revision: number) {
    const observed = yield* read(projectId);
    const entry = observed.entries.find(row => row.hostname === hostname);
    if (!entry) return yield* missing();
    if (entry.revision !== revision) return yield* conflict();
    return { observed, entry };
  });
  const replace = Effect.fn("ProjectDomains.replace")(function* (
    projectId: string, { observed, entry }: Effect.Success<ReturnType<typeof current>>, changes: Partial<StoredDomain>,
  ) {
    if (observed.revision >= Number.MAX_SAFE_INTEGER) return yield* conflict();
    const next = { ...entry, ...changes, revision: observed.revision + 1, updatedAt: time() };
    yield* save(projectId, observed, observed.entries.map(row => row.id === entry.id ? next : row));
    return next;
  });
  const live = <A>(id: string, effect: Effect.Effect<A, TaggedFailure>) => Effect.suspend(() => {
    const projects = options.projects();
    if (!projects || !isCanonicalProjectId(id)) return Effect.fail(missing());
    return projects.withLiveProject(id, () => effect).pipe(Effect.mapError(error => {
      if (error instanceof ZelavisProjectNotFoundError) return missing();
      if (error instanceof ZelavisProjectConflictError) return failure("project_deleting", "The Project is being deleted.");
      return error;
    }));
  });
  const ownerFor = (projectId: string, entry: StoredDomain): ProjectHostnameOwner =>
    ({ host: entry.hostname, projectId, domainId: entry.id });
  const owned = Effect.fn("ProjectDomains.owned")(function* (owner: ProjectHostnameOwner) {
    const row = yield* integration(() => routes.getHostname(owner.host));
    return row?.scope === "project" && row.projectId === owner.projectId && row.projectDomain?.domainId === owner.domainId ? row : undefined;
  });
  const pending = (entry: StoredDomain) => entry.state === "pending_dns";
  const expired = (entry: StoredDomain) => Date.parse(entry.challengeExpiresAt ?? "") <= now();
  const automatic = (entry: StoredDomain) => entry.dns === "automatic";
  const fromDns = (error: unknown) => {
    if (!(error instanceof EdgeDnsError)) return error as TaggedFailure;
    if (error.code === "hosted_zone_unavailable" || error.code === "dns_zone_not_found") return failure("hosted_zone_unavailable", error.message);
    if (error.code === "dns_provider_failed" || error.code === "dns_provider_unavailable" || error.code === "invalid_dns_connection") {
      return failure("dns_provider_failed", error.message);
    }
    return failure("domain_ingress_unavailable", error.message);
  };
  const hostedZone = Effect.fn("ProjectDomains.hostedZone")(function* (hostname: string) {
    if (!dns) return yield* failure("hosted_zone_unavailable", "This installation offers no hosted subdomains.");
    const zone = yield* dns.hostedZoneFor(hostname).pipe(Effect.mapError(fromDns));
    if (!zone) return yield* failure("hosted_zone_unavailable", "Choose a name one label below a zone this installation offers.");
    return zone;
  });

  /** Creates the zone's address records for a hosted subdomain, each id persisted on the entry as it is made. */
  const ensureRecords = Effect.fn("ProjectDomains.ensureRecords")(function* (projectId: string, entry: StoredDomain) {
    if (!automatic(entry)) return entry;
    const zone = yield* hostedZone(entry.hostname);
    let latest = entry;
    for (const target of hostedRecordsFor(zone)) {
      if ((latest.dnsRecords ?? []).some(row => row.provider === zone.provider && row.zoneId === zone.zoneId &&
          row.type === target.type && row.content === target.content)) continue;
      if ((latest.dnsRecords?.length ?? 0) >= MAX_DNS_RECORDS) return yield* failure("domain_ingress_unavailable", "The hosted subdomain holds its record limit.");
      const record = { name: entry.hostname, type: target.type, content: target.content, ttl: 300 };
      // A record made by an attempt that stopped before recording its id is taken over rather than duplicated.
      const found = yield* dns!.findRecord(zone, record).pipe(Effect.mapError(fromDns));
      const ref = found ?? (yield* dns!.createRecord(zone, record).pipe(Effect.mapError(fromDns)));
      latest = yield* live(projectId, Effect.gen(function* () {
        const snapshot = yield* current(projectId, latest.hostname, latest.revision);
        return yield* replace(projectId, snapshot, { dnsRecords: [...(snapshot.entry.dnsRecords ?? []),
          { provider: ref.provider, zoneId: ref.zoneId, recordId: ref.recordId, type: target.type, content: target.content }] });
      }));
    }
    return latest;
  });

  /** Removes exactly the records Zelavis made for a hosted subdomain: by persisted id, then any it made without one. */
  const releaseRecords = Effect.fn("ProjectDomains.releaseRecords")(function* (entry: StoredDomain) {
    if (!automatic(entry)) return;
    if (!dns) return yield* failure("domain_ingress_unavailable", "DNS automation is unavailable; the hosted subdomain's records cannot be removed.");
    const apex = entry.hostname.slice(entry.hostname.indexOf(".") + 1);
    for (const ref of entry.dnsRecords ?? []) yield* dns.removeRecord(ref, apex).pipe(Effect.mapError(fromDns));
    const zone = yield* dns.hostedZoneFor(entry.hostname).pipe(Effect.mapError(fromDns));
    if (!zone) return;
    for (const target of hostedRecordsFor(zone)) {
      yield* dns.removeMatching(zone, { name: entry.hostname, type: target.type, content: target.content }).pipe(Effect.mapError(fromDns));
    }
  });

  const prove = Effect.fn("ProjectDomains.prove")(function* (projectId: string, entry: StoredDomain) {
    const owner = ownerFor(projectId, entry);
    if (yield* owned(owner)) return entry;
    if (automatic(entry)) {
      // The operator's zone owns a hosted subdomain: there is no TXT to prove, only the zone to still offer it.
      yield* hostedZone(entry.hostname);
      return yield* live(projectId, Effect.gen(function* () {
        const { entry: latest } = yield* current(projectId, entry.hostname, entry.revision);
        if (!(yield* integration(() => routes.claimProjectHostname(owner, latest.verifiedAt!)))) return yield* unavailable();
        return latest;
      }));
    }
    if (entry.verifiedAt && now() - Date.parse(entry.verifiedAt) < PROOF_MS) {
      return yield* live(projectId, Effect.gen(function* () {
        const { entry: latest } = yield* current(projectId, entry.hostname, entry.revision);
        if (!(yield* integration(() => routes.claimProjectHostname(owner, latest.verifiedAt!)))) return yield* unavailable();
        return latest;
      }));
    }
    if (!entry.challengeToken || expired(entry)) {
      return yield* failure("dns_not_verified", "The TXT challenge expired. Add the hostname again for a new challenge.");
    }
    if (!ingress?.dns) return yield* failure("domain_ingress_unavailable", "DNS verification is unavailable on this installation.");
    const permitted = yield* dnsPermits.withPermitsIfAvailable(1)(Effect.gen(function* () {
      const attempt = yield* live(projectId, Effect.gen(function* () {
        const snapshot = yield* current(projectId, entry.hostname, entry.revision);
        const remaining = RETRY_MS - (now() - Date.parse(snapshot.entry.lastCheckedAt ?? ""));
        if (remaining > 0) return yield* failure("domain_verification_busy", "Wait before checking the TXT record again.", Math.ceil(remaining / 1000));
        return yield* replace(projectId, snapshot, { lastCheckedAt: time() });
      }));
      const proof = yield* Effect.result(checkDomainBindingDnsProof(entry.hostname, entry.challengeToken!, { resolver: ingress.dns })
        .pipe(Effect.timeout("5 seconds")));
      return yield* live(projectId, Effect.gen(function* () {
        const snapshot = yield* current(projectId, attempt.hostname, attempt.revision);
        if (proof._tag === "Failure" || expired(snapshot.entry)) {
          const error = proof._tag === "Failure" ? proof.failure : undefined;
          const cause = error?.cause;
          const dnsCode = cause instanceof Error && typeof cause.cause === "object" && cause.cause !== null && "code" in cause.cause
            ? cause.cause.code : undefined;
          // A missing record (or one published as a CNAME) is the customer's to fix; anything else is DNS not answering.
          const missingTxt = error instanceof DnsTxtProofMissing || dnsCode === "ENODATA" || dnsCode === "ENOTFOUND" || dnsCode === "ECNAME";
          yield* replace(projectId, snapshot, { issue: missingTxt ? "dns_pending" : "dns_unavailable" });
          return yield* failure("dns_not_verified", missingTxt
            ? "The TXT record does not contain the current challenge."
            : "The TXT record could not be verified. Check the challenge and try again.");
        }
        const verifiedAt = time();
        const verified = yield* replace(projectId, snapshot, { state: "verified", verifiedAt, issue: "publication_pending" });
        if (!(yield* integration(() => routes.claimProjectHostname(owner, verifiedAt)))) return yield* unavailable();
        return verified;
      }));
    }));
    if (permitted._tag === "None") return yield* failure("domain_verification_busy", "DNS verification is busy. Try again shortly.", 5);
    return permitted.value;
  });

  const note = (projectId: string, entry: StoredDomain, issue: typeof storedEntry.Type.issue) =>
    live(projectId, Effect.gen(function* () {
      const snapshot = yield* current(projectId, entry.hostname, entry.revision);
      return snapshot.entry.issue === issue ? snapshot.entry : yield* replace(projectId, snapshot, { issue });
    }));

  const targetFor = Effect.fn("ProjectDomains.target")(function* (mode: ProjectDomainTlsMode) {
    if (mode === "external") {
      const target = ingress?.externalTarget;
      return target && isProjectDomainLoopbackTarget(target) ? target : undefined;
    }
    if (!manager || !ingress?.probe) return undefined;
    const fallback = yield* integration(() => routes.getRoute("platform:default"));
    const target = fallback?.targets[0]?.url;
    return fallback?.scope === "platform" && fallback.hostname === "*" && fallback.targets.length === 1 &&
      target && isProjectDomainLoopbackTarget(target) ? target : undefined;
  });

  const apply = Effect.fn("ProjectDomains.apply")(function* (projectId: string, entry: StoredDomain, withdrawing: boolean) {
    const snapshot = yield* current(projectId, entry.hostname, entry.revision);
    if (!entry.stagedRoute || entry.tlsMode === "external") return { entry, ready: true };
    if (!manager) return { entry, ready: false };
    const policy = yield* integration(() => manager.getPolicy());
    if (!policy.activeAdapterId) return { entry, ready: false };
    const id = projectDomainRouteId(entry.id);
    const desired = yield* integration(() => routes.getCurrentPublication());
    const routeIntent = withdrawing ? undefined : yield* integration(() => routes.getRoute(id));
    const hostIntent = withdrawing ? undefined : yield* owned(ownerFor(projectId, entry));
    const matches = (publication: typeof desired) => {
      const route = publication?.routes.find(row => row.id === id);
      const hostname = publication?.hostnames.find(row => row.projectDomain?.domainId === entry.id);
      return withdrawing ? !route && !hostname : route?.projectId === projectId && hostname?.projectId === projectId &&
        route.targets[0]?.url === routeIntent?.targets[0]?.url && hostname.certificateRef === hostIntent?.certificateRef;
    };
    const previous = entry.publicationRevision === undefined ? undefined
      : yield* integration(() => routes.getPublication(entry.publicationRevision!));
    const publication = previous && previous.revision === desired?.revision && matches(previous)
      ? previous : yield* integration(() => routes.compile());
    if (!matches(publication)) return { entry, ready: false };
    const staged = snapshot.entry.publicationRevision === publication.revision
      ? snapshot.entry : yield* replace(projectId, snapshot, { publicationRevision: publication.revision });
    const summary = toPublicationSummary(publication);
    const acknowledged = (active: typeof policy) => active.activeAdapterId === policy.activeAdapterId &&
      active.activePublication?.id === summary.id && active.activePublication.revision === summary.revision;
    if (!acknowledged(policy)) {
      const applied = yield* Effect.result(integration(() => manager.switchAdapter(policy.activeAdapterId!, summary)));
      if (applied._tag === "Failure" || applied.success.phase !== "complete") return { entry: staged, ready: false };
    }
    const active = yield* integration(() => manager.getPolicy());
    return { entry: staged, ready: acknowledged(active) };
  });

  const acknowledged = Effect.fn("ProjectDomains.acknowledged")(function* (entry: StoredDomain) {
    if (entry.tlsMode !== "managed" || !entry.stagedRoute) return true;
    if (!manager || entry.publicationRevision === undefined) return false;
    const { activeAdapterId, activePublication } = yield* integration(() => manager.getPolicy());
    return Boolean(activeAdapterId && activePublication?.id === "zelavis-edge-routes" &&
      activePublication.revision === String(entry.publicationRevision));
  });

  const activate = Effect.fn("ProjectDomains.activate")(function* (projectId: string, entry: StoredDomain) {
    const owner = ownerFor(projectId, entry);
    const target = yield* targetFor(entry.tlsMode);
    if (!target || !ingress?.probe || (entry.tlsMode === "managed" && (!certificates || !ingress.preflight || !ingress.probeWithdrawal))) {
      return yield* note(projectId, entry, "edge_unavailable");
    }
    let certificateRef: string | undefined;
    if (entry.tlsMode === "managed") {
      const policy = yield* integration(() => manager!.getPolicy());
      const adapters = yield* integration(() => manager!.listAdapters());
      if (!adapters.some(adapter => adapter.id === policy.activeAdapterId && adapter.detection.installed &&
          adapter.detection.healthy && adapter.capabilities.includes("https") && adapter.capabilities.includes("certificate-hot-reload"))) {
        return yield* note(projectId, entry, "edge_unavailable");
      }
      // A hosted subdomain is issued under its zone's wildcard through DNS-01, so it needs no HTTP reachability first.
      const ready = automatic(entry) || (yield* integration(() => ingress!.preflight!(entry.hostname), { interruptible: true }).pipe(
        Effect.timeout("5 seconds"), Effect.catch(() => Effect.succeed(false))));
      if (!ready) return yield* note(projectId, entry, "certificate_pending");
      const reserve = live(projectId, Effect.gen(function* () {
        yield* current(projectId, entry.hostname, entry.revision);
        if (!(yield* owned(owner))) return yield* conflict();
        if (orders.has(entry.id)) return yield* failure("domain_verification_busy", "Certificate issuance is in progress.", 5);
        const order = new AbortController();
        orders.set(entry.id, order);
        return order;
      }));
      const ordered = yield* certificatePermits.withPermitsIfAvailable(1)(Effect.acquireUseRelease(
        reserve,
        order => Effect.result(Effect.gen(function* () {
          if (automatic(entry)) {
            const zone = yield* hostedZone(entry.hostname);
            const wildcard = `*.${zone.apex}`;
            const existing = yield* integration(() => certificates!.getCertificate(zone.wildcardCertificateRef ?? `certificate:${wildcard}`));
            if (existing?.hostname === wildcard && existing.status === "valid" && Date.parse(existing.expiresAt) > now()) return existing;
            const ordered = yield* integration(() => certificates!.orderCertificate({
              hostname: wildcard, challenge: "dns-01", signal: AbortSignal.any([order.signal, AbortSignal.timeout(300_000)]),
            }));
            yield* dns!.setWildcardCertificate(zone.apex, ordered.ref).pipe(Effect.mapError(fromDns));
            return ordered;
          }
          const ref = `certificate:${entry.hostname}`;
          const existing = yield* integration(() => certificates!.getCertificate(ref));
          if (existing?.hostname === entry.hostname && existing.status === "valid" && Date.parse(existing.expiresAt) > now()) return existing;
          if (existing?.sanHostnames?.some(host => host !== entry.hostname)) {
            return yield* failure("domain_ingress_unavailable", "The operator must renew the shared certificate.");
          }
          return yield* integration(() => certificates!.orderCertificate({
            hostname: entry.hostname, projectDomainId: entry.id, signal: AbortSignal.any([order.signal, AbortSignal.timeout(90_000)]),
          }));
        })),
        () => Effect.sync(() => { orders.delete(entry.id); }),
      ));
      if (ordered._tag === "None" || ordered.value._tag === "Failure" || ordered.value.success.status !== "valid" ||
          Date.parse(ordered.value.success.expiresAt) <= now()) return yield* note(projectId, entry, "certificate_pending");
      certificateRef = ordered.value.success.ref;
    }
    const staged = yield* live(projectId, Effect.gen(function* () {
      const snapshot = yield* current(projectId, entry.hostname, entry.revision);
      if (!(yield* integration(() => routes.stageProjectHostname(owner, entry.tlsMode, certificateRef)))) return yield* conflict();
      const next = snapshot.entry.state === "publishing" ? snapshot.entry :
        yield* replace(projectId, snapshot, { state: "publishing", issue: "publication_pending", stagedRoute: true });
      yield* integration(() => routes.putProjectDomainRoute(owner, {
        id: projectDomainRouteId(entry.id), scope: "project", projectId, hostname: entry.hostname,
        pathPrefix: "/", pathMatch: "prefix", protocols: ["http", "websocket", "sse"], priority: 10,
        targets: [{ url: target, weight: 100 }], createdAt: entry.createdAt, updatedAt: time(),
      }));
      return next;
    }));
    const applied = yield* publicationPermit.withPermit(apply(projectId, staged, false));
    if (!applied.ready) return applied.entry;
    const probed = yield* integration(() => ingress.probe!(entry.hostname, entry.tlsMode), { interruptible: true }).pipe(
      Effect.timeout("5 seconds"), Effect.catch(() => Effect.succeed(false)));
    if (!probed) return applied.entry;
    return yield* live(projectId, Effect.gen(function* () {
      const snapshot = yield* current(projectId, entry.hostname, applied.entry.revision);
      if (snapshot.observed.revision >= Number.MAX_SAFE_INTEGER) return yield* conflict();
      if (entry.tlsMode === "managed" && !(yield* acknowledged(snapshot.entry))) return snapshot.entry;
      if (!(yield* integration(() => routes.activateProjectHostname(owner)))) return yield* conflict();
      const { issue: _issue, challengeToken: _token, challengeExpiresAt: _expiry, ...active } = snapshot.entry;
      const next = { ...active, state: "active" as const, activatedAt: time(), revision: snapshot.observed.revision + 1, updatedAt: time() };
      yield* save(projectId, snapshot.observed, snapshot.observed.entries.map(row => row.id === next.id ? next : row));
      return next;
    }));
  });

  const beginWithdrawal = Effect.fn("ProjectDomains.beginWithdrawal")(function* (projectId: string, hostname: string, revision: number) {
    const snapshot = yield* current(projectId, hostname, revision);
    const owner = ownerFor(projectId, snapshot.entry);
    orders.get(snapshot.entry.id)?.abort();
    if ((yield* owned(owner)) && !(yield* integration(() => routes.blockProjectHostname(owner)))) return yield* conflict();
    const removing = snapshot.entry.state === "removing" ? snapshot.entry :
      yield* replace(projectId, snapshot, { state: "removing", issue: "publication_pending" });
    yield* integration(() => routes.deleteProjectDomainRoute(owner));
    return removing;
  });
  const withdraw = Effect.fn("ProjectDomains.withdraw")(function* (projectId: string, entry: StoredDomain) {
    if (!entry.stagedRoute || entry.tlsMode === "external") return { entry, ready: true };
    return yield* publicationPermit.withPermit(Effect.gen(function* () {
      const applied = yield* apply(projectId, entry, true);
      if (!applied.ready || !ingress?.probeWithdrawal) return { entry: applied.entry, ready: false };
      const withdrawn = yield* integration(() => ingress.probeWithdrawal!(entry.hostname), { interruptible: true }).pipe(
        Effect.timeout("5 seconds"), Effect.catch(() => Effect.succeed(false)));
      return { entry: applied.entry, ready: withdrawn };
    }));
  });
  const finishWithdrawal = Effect.fn("ProjectDomains.finishWithdrawal")(function* (projectId: string, entry: StoredDomain) {
    const { observed } = yield* current(projectId, entry.hostname, entry.revision);
    const owner = ownerFor(projectId, entry);
    if (!(yield* acknowledged(entry))) return false;
    if (yield* owned(owner)) {
      if (certificates && entry.tlsMode === "managed") {
        const ref = `certificate:${entry.hostname}`;
        const inventory = yield* integration(() => routes.listHostnames());
        const shared = inventory.some(row => row.projectDomain?.domainId !== entry.id && row.certificateRef === ref);
        const published = entry.publicationRevision === undefined ? undefined :
          yield* integration(() => routes.getPublication(entry.publicationRevision!));
        if (!shared && !published?.certificateRefs.includes(ref)) {
          yield* integration(() => certificates.retireProjectCertificate(ref, entry.id));
        }
      }
      yield* releaseRecords(entry);
      if (!(yield* integration(() => routes.releaseProjectHostname(owner)))) return yield* conflict();
    } else {
      yield* releaseRecords(entry);
    }
    yield* save(projectId, observed, observed.entries.filter(row => row.id !== entry.id));
    return true;
  });

  /** Proof, address records, then activation: the step `verify` retries until the domain is active. */
  const settle = Effect.fn("ProjectDomains.settle")(function* (projectId: string, entry: StoredDomain) {
    if (entry.state === "removing") return yield* conflict();
    if (entry.state === "active") {
      if ((yield* owned(ownerFor(projectId, entry)))?.projectDomain?.routing !== "active") return yield* conflict();
      return entry;
    }
    const verified = yield* prove(projectId, entry);
    const addressed = yield* ensureRecords(projectId, verified);
    const activation = yield* activationPermits.withPermitsIfAvailable(1)(activate(projectId, addressed));
    if (activation._tag === "None") return yield* failure("domain_verification_busy", "Ingress activation is busy. Try again shortly.", 5);
    return activation.value;
  });

  /** A hosted subdomain: claimed at once (the operator's zone owns it), addressed, and activated under the zone's wildcard. */
  const addHosted = (projectId: string, input: AddProjectDomainInput) => present(Effect.gen(function* () {
    const hostname = yield* normalize(input.hostname);
    if (input.tlsMode !== "managed") return yield* failure("hosted_zone_unavailable", "A hosted subdomain uses managed TLS.");
    yield* hostedZone(hostname);
    const added = yield* live(projectId, Effect.gen(function* () {
      const observed = yield* read(projectId);
      const previous = observed.entries.find(entry => entry.hostname === hostname);
      const claimed = yield* integration(() => routes.getHostname(hostname));
      if (claimed && !(previous && claimed.projectId === projectId && claimed.projectDomain?.domainId === previous.id)) return yield* unavailable();
      if (previous) {
        if (!automatic(previous) || previous.state === "removing") return yield* conflict();
        return { entry: previous, created: false };
      }
      const entries = observed.entries.filter(row => !(pending(row) && expired(row)));
      if (entries.length >= MAX_DOMAINS) return yield* failure("domain_limit", "This Project already has 20 domains.");
      if (observed.revision >= Number.MAX_SAFE_INTEGER) return yield* conflict();
      const verifiedAt = time();
      const entry: StoredDomain = {
        id: crypto.randomUUID(), hostname, tlsMode: "managed", dns: "automatic", state: "verified", verifiedAt,
        revision: observed.revision + 1, createdAt: verifiedAt, updatedAt: verifiedAt, issue: "publication_pending",
      };
      yield* save(projectId, observed, [...entries, entry]);
      if (!(yield* integration(() => routes.claimProjectHostname(ownerFor(projectId, entry), verifiedAt)))) {
        const latest = yield* read(projectId);
        yield* save(projectId, latest, latest.entries.filter(row => row.id !== entry.id));
        return yield* unavailable();
      }
      return { entry, created: true };
    }));
    // Records and activation are retried by `verify`; what this attempt reached is what the customer sees.
    const settled = yield* Effect.result(settle(projectId, added.entry));
    if (settled._tag === "Success") return { domain: presentDomain(projectId, settled.success), created: added.created };
    const latest = (yield* read(projectId)).entries.find(row => row.id === added.entry.id);
    if (!latest) return yield* Effect.fail(settled.failure);
    yield* Effect.logWarning("Hosted subdomain activation deferred", { projectId, hostname, error: describeFailure(settled.failure) });
    return { domain: presentDomain(projectId, latest), created: added.created };
  }));

  return {
    list: projectId => present(Effect.gen(function* () {
      if (!isCanonicalProjectId(projectId)) return yield* missing();
      const project = yield* integration(() => options.projects()?.view(projectId));
      if (!project) return yield* missing();
      const { entries } = yield* read(project.id);
      const domains = yield* Effect.forEach(entries, entry => Effect.gen(function* () {
        if (entry.state === "active" && (yield* owned(ownerFor(projectId, entry)))?.projectDomain?.routing !== "active") {
          return presentDomain(projectId, { ...entry, state: "removing", issue: "publication_pending" });
        }
        return presentDomain(projectId, entry);
      }), { concurrency: 4 });
      return { domains };
    })),
    add: (projectId, input) => input.dns === "automatic" ? addHosted(projectId, input) : present(live(projectId, Effect.gen(function* () {
      const hostname = yield* normalize(input.hostname);
      const observed = yield* read(projectId);
      const previous = observed.entries.find(entry => entry.hostname === hostname);
      const claimed = yield* integration(() => routes.getHostname(hostname));
      if (claimed && !(previous && claimed.projectId === projectId && claimed.projectDomain?.domainId === previous.id)) return yield* unavailable();
      if (previous) {
        if (previous.tlsMode !== input.tlsMode || automatic(previous) || previous.state === "removing") return yield* conflict();
        if (claimed || !expired(previous)) return { domain: presentDomain(projectId, previous), created: false };
      }
      const entries = observed.entries.filter(row => row.id !== previous?.id && !(pending(row) && expired(row)));
      if (entries.length >= MAX_DOMAINS) return yield* failure("domain_limit", "This Project already has 20 domains.");
      if (observed.revision >= Number.MAX_SAFE_INTEGER) return yield* conflict();
      const entry: StoredDomain = {
        id: previous?.id ?? crypto.randomUUID(), hostname, tlsMode: input.tlsMode, state: "pending_dns",
        revision: observed.revision + 1, createdAt: previous?.createdAt ?? time(), updatedAt: time(),
        challengeToken: generateVerificationToken(), challengeExpiresAt: new Date(now() + CHALLENGE_MS).toISOString(), issue: "dns_pending",
      };
      yield* save(projectId, observed, [...entries, entry]);
      return { domain: presentDomain(projectId, entry), created: !previous };
    }))),
    verify: (projectId, raw, { expectedRevision }) => present(Effect.gen(function* () {
      const hostname = yield* normalize(raw);
      const { entry } = yield* live(projectId, current(projectId, hostname, expectedRevision));
      return presentDomain(projectId, yield* settle(projectId, entry));
    })),
    hostedZones: projectId => present(Effect.gen(function* () {
      if (!isCanonicalProjectId(projectId) || !(yield* integration(() => options.projects()?.view(projectId)))) return yield* missing();
      const apexes = dns ? yield* dns.hostedApexes().pipe(Effect.mapError(fromDns)) : [];
      return { zones: apexes.map(apex => ({ apex })) };
    })),
    remove: (projectId, raw, expectedRevision) => present(Effect.gen(function* () {
      const hostname = yield* normalize(raw);
      const snapshot = yield* live(projectId, Effect.gen(function* () {
        const { entries } = yield* read(projectId);
        return entries.some(row => row.hostname === hostname)
          ? yield* beginWithdrawal(projectId, hostname, expectedRevision) : undefined;
      }));
      if (!snapshot) return { removed: false, pending: false };
      const result = yield* withdraw(projectId, snapshot);
      if (!result.ready) return { removed: false, pending: true };
      const removed = yield* live(projectId, finishWithdrawal(projectId, result.entry));
      return { removed, pending: !removed };
    })),
    cleanup: projectId => Effect.gen(function* () {
      const { entries } = yield* read(projectId);
      for (const entry of entries) {
        const snapshot = yield* beginWithdrawal(projectId, entry.hostname, entry.revision);
        const result = yield* withdraw(projectId, snapshot);
        if (!result.ready || !(yield* finishWithdrawal(projectId, result.entry))) {
          return yield* failure("domain_ingress_unavailable", "Edge has not acknowledged domain withdrawal.");
        }
      }
    }),
  };
}
