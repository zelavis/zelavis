# Design: ACME / Let's Encrypt Provider

**Status:** Draft — not yet implemented
**Slot:** PR D in the TLS / domain-verification arc (#52 → #53 → #54 → this)
**Author:** Claude + Ivan
**Date:** 2026-05-20

## Why this is a design doc, not code

The other PRs in this arc shipped seams and reference implementations
that could be tested deterministically — mock cert maps, in-memory
binding stores, mock DNS resolvers, mock `fetch`. ACME is different.
Its bugs only show up under real-server testing:

- JWS signing must match what the ACME server expects to the byte.
- JWK thumbprint construction is a specific JSON canonicalization.
- Account-key reuse, nonce replay, challenge polling cadence — all
  surfaced by the server returning a 400 with a non-obvious error
  code, not by anything the client can self-detect.
- Real ACME servers (Let's Encrypt, ZeroSSL) and the local test
  server (Pebble, Boulder) differ in subtle ways.

Shipping a speculative ACME implementation without an integration
test loop against Pebble/staging has a real chance of producing code
that "looks right" but doesn't actually work with Let's Encrypt.
That's worse than no implementation — it creates a false sense of
coverage.

So: lock the shape here, then implement it once the test loop is in
place (or once we've decided we're comfortable with the trade-offs).

## What "good" looks like

When this lands, a self-hosted Node/Bun operator can write:

```ts
import { createAcmeTlsProvider, chainTlsProviders, zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const acme = createAcmeTlsProvider({
  directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
  accountKeyStore: { /* persisted account key + URL */ },
  accountEmail: "ops@example.com",
  certificateStore: { /* where to cache cert+key pairs */ },
  // The provider needs to be able to serve HTTP-01 challenges — it
  // hooks into the same `/.well-known/...` infrastructure from #54.
  challengeStore: { /* where to stash pending challenge tokens */ },
});

await zelavis({
  adapter: nodeAdapter({ ... }),
  tls: chainTlsProviders(manualOverrides, acme),
});
```

And from then on:

1. A `TlsProvider.getCertificate("acme.com")` call against the chain
   either returns a cached cert from `certificateStore` if there is
   one, or kicks off an ACME order, completes the challenge against
   our own HTTP-01 endpoint, and returns the fresh cert.
2. A separate background task renews certs that are within N days of
   expiry, without involving the request path.
3. Operators see provisioning progress in the dashboard (status:
   "pending challenge", "validating", "issued", "errored").

## Scope

### In scope

- ACME v2 (RFC 8555) client implementation.
- HTTP-01 challenge — already half-wired via `createDomainChallengeService`
  in #54; ACME's challenge path is `/.well-known/acme-challenge/<token>`,
  ours is `/.well-known/zelavis-challenge/<token>`. Two responders, same
  store shape.
- DNS-01 challenge — required for wildcard certs, optional for
  non-wildcard. Pluggable DNS publisher interface so operators
  with Cloudflare/Route53/etc can wire their provider.
- Account key persistence (account is created once per directory URL).
- Order + finalize flow with CSR generation.
- Cert caching with `expiresAt` awareness so reissue doesn't fire on
  every request.
- Renewal scheduler (background loop, with a manual `renew()`
  entrypoint for admins).
- Plug into the `TlsProvider` interface from #52 so callers don't
  need to know it's ACME under the hood.
- Plug the HTTP-01 challenge responder into the same path
  `/.well-known/acme-challenge/...` that `createDomainChallengeService`
  uses, parameterized over the path constant.

### Out of scope (for now)

- **EAB (External Account Binding)** — required for some CAs (ZeroSSL).
  Defer until a real demand surfaces; the directory format already
  supports it, adding the field later is non-breaking.
- **ACME revocation** — operators who need to revoke can use the CA's
  CLI for now; revocation is rare and the use case is niche.
- **Wildcard certs without a DNS publisher plugin.** Wildcards
  require DNS-01, which requires DNS API access; if the operator
  doesn't have one configured, we issue per-host certs instead.
- **Multi-host SAN certs in a single order.** Possible per RFC, but
  introduces ordering questions (what if one of 5 hosts fails to
  validate?). Ship one-cert-per-host first.

## Architecture

### Module layout

```
packages/zelavis/src/
  acme/
    index.ts              // public exports: createAcmeTlsProvider, ...
    client.ts             // low-level ACME client (newAccount, newOrder, etc)
    jose.ts               // JWS signing, JWK formatting, thumbprints
    csr.ts                // CSR generation (RFC 2986 minimal)
    challenge.ts          // HTTP-01 + DNS-01 publishers
    storage.ts            // AccountKeyStore + CertificateStore + ChallengeStore interfaces
    provider.ts           // wraps client + storage as a TlsProvider
    renewal.ts            // background renewal scheduler
```

Keep `acme/` as a subdirectory so the surface area is contained — most
users won't import any of these directly, just `createAcmeTlsProvider`
from the top-level export.

### Storage interfaces

Three new stores, all with default in-memory + KV-backed implementations
following the same pattern as `DomainBindingStore`:

```ts
interface AcmeAccountKeyStore {
  /** The single account per directory URL. Created on first issuance. */
  get(directoryUrl: string): Promise<AcmeAccount | undefined>;
  put(directoryUrl: string, account: AcmeAccount): Promise<void>;
}

interface AcmeAccount {
  directoryUrl: string;
  accountUrl: string;           // server-assigned URL from newAccount
  keyJwkPrivate: JsonWebKey;    // private key as JWK (P-256 ECDSA recommended)
  contact?: string[];           // mailto: addresses
  createdAt: string;
}

interface AcmeCertificateStore {
  get(host: string): Promise<AcmeCertificateEntry | undefined>;
  put(host: string, entry: AcmeCertificateEntry): Promise<void>;
  list(): Promise<readonly { host: string; expiresAt: string }[]>;
  delete(host: string): Promise<boolean>;
}

interface AcmeCertificateEntry {
  host: string;
  cert: string;                 // PEM cert chain
  key: string;                  // PEM private key
  expiresAt: string;            // ISO
  issuedAt: string;             // ISO
  notBefore?: string;
  serialNumber?: string;
}

interface AcmeChallengeStore {
  /** Set a pending HTTP-01 challenge. The responder reads from here. */
  putHttpChallenge(token: string, keyAuthorization: string, expiresAt: Date): Promise<void>;
  /** Lookup during an incoming `/.well-known/acme-challenge/<token>` request. */
  getHttpChallenge(token: string): Promise<string | undefined>;
  /** Remove after order finalizes / errors. */
  deleteHttpChallenge(token: string): Promise<boolean>;
}
```

The challenge store is **separate from `DomainBindingStore`** because:

- ACME challenge tokens are ephemeral (TTL on the order of minutes).
- The key authorization format (`token.thumbprint`) is ACME-specific.
- Conflating them would mean either ACME pollutes the binding model,
  or domain bindings carry ACME-specific fields that other
  verification methods don't need.

Both binding and ACME challenge can live in the same underlying KV
backend — different prefixes — without sharing types.

### `TlsProvider` integration

```ts
function createAcmeTlsProvider(options: CreateAcmeTlsProviderOptions): TlsProvider {
  return {
    name: "acme",
    async getCertificate(hostname) {
      const cached = await options.certificateStore.get(hostname);
      if (cached && new Date(cached.expiresAt) > addDays(new Date(), 1)) {
        return { cert: cached.cert, key: cached.key, expiresAt: new Date(cached.expiresAt) };
      }
      // Cache miss or near-expiry → issue
      return options.deferIssue
        ? cached  // serve stale; let renewal loop handle reissue
        : await issueAndPersist(hostname, options);
    },
    listHostnames() {
      return options.certificateStore.list().then((rows) => rows.map((r) => r.host));
    },
  };
}
```

Two important properties this gets right:

1. **Cache-first.** A working cert is returned immediately even if
   it's close to expiry; renewal runs in the background. This avoids
   the "first request blocks on ACME" failure mode.
2. **Graceful expiry handling.** A near-expiry cert (within ~24h) is
   still returned if reissue fails — better to serve a slightly-old
   cert than 503 on TLS handshake.

### Challenge flow

When an issuance is needed:

1. Authorize account against `directoryUrl` (use existing or create).
2. Create a new order for `[hostname]` (one host per cert for now).
3. Fetch the authorization, pick HTTP-01 (or DNS-01 if configured).
4. Compute key authorization: `token + "." + base64url(SHA-256(account_jwk_thumbprint))`.
5. `challengeStore.putHttpChallenge(token, keyAuthorization, expiresAt: +10min)`.
6. POST to challenge URL to tell the CA "go ahead and validate".
7. Poll authorization status until `valid` or `invalid` (with exponential
   backoff, capped at ~60s total).
8. On `valid`: generate CSR, finalize order, poll until `valid`, download
   cert.
9. `certificateStore.put(host, entry)`.
10. `challengeStore.deleteHttpChallenge(token)`.

The HTTP-01 responder (separate from `createDomainChallengeService`):

```ts
function createAcmeChallengeService(store: AcmeChallengeStore): ZelavisService {
  // Mounted at /.well-known/acme-challenge/:token, host-agnostic.
  // Returns keyAuthorization on hit, 404 otherwise.
  // Auto-wired by zelavis() when the ACME provider is in the TLS chain.
}
```

### Renewal scheduler

```ts
interface AcmeRenewalScheduler {
  /** Start the background loop. Returns a stop() function. */
  start(options: { intervalMs?: number; renewIfWithinDays?: number }): () => void;
  /** Run one pass synchronously. Useful for cron-driven hosts. */
  runOnce(): Promise<{ renewed: string[]; failed: { host: string; error: string }[] }>;
}
```

Polls `certificateStore.list()` on an interval (default 1 hour),
finds entries within `renewIfWithinDays` of expiry (default 30), and
reissues them through the same path `getCertificate` uses.

Failures are logged and surfaced via the result; they don't crash the
loop. Operators see them via an admin endpoint (which lists
`certificateStore` with their statuses).

## Cryptography

This is where the most care is needed. ACME requires:

- **Account key**: ECDSA P-256 by default (well-supported by all CAs).
  Generated via `crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" })`.
- **JWS signatures** on every ACME POST. Body must be the JWS
  envelope with `protected: { alg: "ES256", kid: accountUrl, nonce, url }`.
- **JWK thumbprint** (RFC 7638) for the key authorization. Specific
  JSON canonicalization: only `crv`, `kty`, `x`, `y` in that order,
  no whitespace, base64url SHA-256.
- **CSR**: ASN.1 DER, signed with the cert's own key (separate from
  account key). One CN + SANs.

**The cryptography is the highest-risk part of the implementation.**
Web Crypto can do all of this in modern Node/Bun/Workers, but the
encoding details are easy to get wrong:

- JWS protected header must NOT contain `kid` for the initial
  `newAccount` call (uses `jwk` instead).
- Nonce comes from a previous response's `Replay-Nonce` header; the
  server rejects reused nonces with `urn:ietf:params:acme:error:badNonce`.
- CSR DER encoding has a fixed byte layout that's painful to
  hand-roll; might want to vendor a small ASN.1 helper.

Decision point: **build vs. wrap an existing library.** Options:

- **`acme-client`** (npm) — mature, used in production by many. Drag
  is that it's Node-specific (uses `node:crypto`), so we'd lose
  Workers/Bun compatibility.
- **`@hyperjump/json-pointer`** + **`jose`** + hand-rolled ACME flow.
  Runtime-portable, but more code and more bugs.
- **Hand-roll everything with Web Crypto.** Most portable, most code,
  highest risk.

**Recommendation**: ship with `acme-client` as an optional peer
dependency. Self-host Node users (the only place this matters anyway —
edge platforms terminate TLS themselves) get a battle-tested
implementation; the seam is the `TlsProvider` interface, so swapping
in a portable version later is non-breaking.

This means the ACME provider is **Node-adapter-specific**, exported
from `zelavis/adapters/node` rather than the top-level. Cloudflare/
Vercel/Netlify don't need it.

## Testing strategy

Three tiers:

1. **Unit tests** (deterministic): JWS signing produces the bytes
   we expect, JWK thumbprint matches a known fixture, CSR DER
   round-trips correctly, challenge store CRUD, renewal scheduler
   selects the right entries.
2. **Integration tests against Pebble** (the lightweight ACME server
   built for testing): real protocol flow with a fake CA. Runs in CI
   via Docker.
3. **Manual staging test**: one-shot run against Let's Encrypt
   staging directory before each release that touches ACME code.

Without tier 2, the ACME PR shouldn't merge. That's the whole point
of this design doc — we don't ship the code until the test loop is
in place.

## Open questions for review

1. **`acme-client` peer dep vs. hand-roll.** I lean toward `acme-client`
   for the reasons above, but it's a real trade-off. Cost: Node-only.
   Benefit: known-good implementation, fewer obscure bugs.
2. **Should the challenge responder live in core (`createAcmeChallengeService`
   wired automatically when the ACME provider is in the TLS chain),
   or in the ACME module itself?** Either works; core wiring is more
   convenient but mixes concerns. I lean toward auto-wiring as long
   as we can pull it apart later.
3. **What's the right `intervalMs` for the renewal loop?** Default
   1 hour seems fine, but operators with thousands of certs might
   want shorter. Make it configurable from day one and pick a sane
   default.
4. **Should the provider be eager or lazy on `getCertificate` miss?**
   Eager (issue inline, block the request) is simpler but means the
   first TLS handshake takes ~30s. Lazy (return undefined, return
   a self-signed temp cert from the chain, issue in background) is
   nicer UX but requires a working "temporary cert" provider behind
   it in the chain. I lean toward **eager** + a 30s timeout — if
   issuance takes longer, something's wrong.
5. **EAB now or later?** I said later; revisit if first user needs it.

## What I need to start implementation

- Decision on `acme-client` vs. hand-roll.
- A Pebble/Boulder integration test setup in CI (or a willingness to
  manually validate against staging before each release).
- Sign-off on the storage interfaces above — once code references
  them, changing the shape gets expensive.

Once those land, the implementation is ~2-3 focused PRs:

- **D1**: Storage interfaces + in-memory + KV implementations + tests.
- **D2**: `acme-client` wrapper + provider + auto-wired challenge
  responder + Pebble integration test.
- **D3**: Renewal scheduler + admin endpoints (status, manual renew,
  delete cert).
