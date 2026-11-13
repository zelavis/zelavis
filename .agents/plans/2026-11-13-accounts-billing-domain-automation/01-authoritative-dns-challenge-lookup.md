# Authoritative DNS challenge lookup for Project domains

Job: Make the Project domain TXT ownership check read the zone's authoritative nameservers, so it holds against real public DNS (negative caching, CNAME-pointed hosts, delegated subzones).
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 1 of 10. Read 00-overview.md first.

To start:    Execute part 1 in .agents/plans/2026-11-13-accounts-billing-domain-automation/01-authoritative-dns-challenge-lookup.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/01-authoritative-dns-challenge-lookup.md. Start with its section 8.

## Progress

- [ ] 1. Prove the domain baseline at HEAD.
- [ ] 2. Add the runtime-neutral DNS wire codec.
- [ ] 3. Add the authoritative DNS test fixture.
- [ ] 4. Add the Node authoritative TXT resolver.
- [ ] 5. Use it for Project domain verification.
- [ ] 6. Document the lookup and its limits.
- [ ] 7. Self-audit.

## 0. Summary and finish line

Project domain verification currently asks the host's recursive resolver (`createNodeDnsTxtResolver`, `packages/zelavis/src/domain-verifier.ts:78`). A customer who presses **Verify DNS** before adding the record makes that resolver cache the negative answer for the zone's SOA minimum (often 30 minutes or more), so the next check fails although the record exists. The VPS qualification never exercised this, because it injected a test resolver. This part finds the zone apex from the SOA in a lookup's authority section, asks that zone's authoritative servers directly (no recursion, authoritative answer required), and keeps every lookup bounded.

- **In scope**: a pure DNS message codec, a Node UDP/TCP transport, zone discovery, authoritative TXT queries, mapping to the existing domain error codes, a local authoritative DNS fixture, tests, docs.
- **Out of scope**: DNSSEC validation, CNAME or DNAME at the challenge name (documented as unsupported), periodic re-verification of verified domains (documented limit), the real public-zone run (part 8), DNS-01 for ACME (part 7 reuses this resolver).
- **Done means**: (a) with the fixture, a check before the record exists fails `dns_not_verified` with `issue: "dns_pending"`, and a check right after the record is added succeeds, with each check reaching the authoritative fixture; (b) a host whose address record is a CNAME into another zone still verifies against its own zone; (c) a delegated child zone is found; (d) unreachable authorities give `issue: "dns_unavailable"`; (e) all lookups are bounded in queries, bytes and time; (f) `pnpm run verify` and `pnpm run docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § Runtime Independence Rule`, `§ TigerStyle Adaptation`, `§ Effect Version`; `packages/zelavis/src/domain-verifier.ts`, `packages/zelavis/src/edge/project-domains.ts`, `packages/zelavis/src/adapters/node.ts:670-700`, `packages/zelavis/test/project-domains.test.mjs`, `website/src/content/docs/architecture/edge.md:75-95`.

## 1. Context packet

**Glossary.**
- **Challenge name**: `_zelavis-challenge.<hostname>` (`domainBindingDnsChallengeName`, `packages/zelavis/src/domain-verifier.ts:142`).
- **Recursive resolver**: the host's configured resolvers (`node:dns` `getServers()`), used only to discover the zone and its nameservers.
- **Authoritative server**: a nameserver listed in the zone's NS set. Its answers carry the AA (authoritative answer) header flag.
- **Zone apex**: the owner name of the SOA record that governs a name. An NXDOMAIN or NODATA response carries that SOA in its authority section.

**Governing rules.**
> "host/framework/provider-specific behavior must live only in `adapters/*` or equivalent adapter boundaries" `AGENTS.md § Runtime Independence Rule`
>
> "`zelavis/backends` must not import `node:` modules; host probes are injected." `AGENTS.md § Platform And App Service Boundary` (the same holds for `src/edge`, which is runtime-neutral).
>
> Effect v4 is mandatory for asynchronous orchestration; pure synchronous calculations stay TypeScript. `AGENTS.md § Effect Version`

**System today.**
- `packages/zelavis/src/domain-verifier.ts:61` `DnsTxtResolver { resolveTxt(host, signal?): Promise<readonly (readonly string[])[]> }`. Implementations throw on lookup failure.
- `packages/zelavis/src/domain-verifier.ts:78` `createNodeDnsTxtResolver()`: lazy `node:dns/promises` `Resolver({ timeout: 4500, tries: 1 })`, recursive.
- `packages/zelavis/src/domain-verifier.ts:146` `checkDomainBindingDnsProof(host, token, { resolver })`: fails `DnsTxtProofMissing` when no record equals the token.
- `packages/zelavis/src/edge/project-domains.ts:16` `RETRY_MS = 30_000`; `:247-276` the verify path: takes one of four DNS permits, records `lastCheckedAt`, runs `checkDomainBindingDnsProof(...).pipe(Effect.timeout("5 seconds"))`, then maps failure. Excerpt (`:258-266`):

```ts
const dnsCode = cause instanceof Error && typeof cause.cause === "object" && cause.cause !== null && "code" in cause.cause
  ? cause.cause.code : undefined;
const missingTxt = error instanceof DnsTxtProofMissing || dnsCode === "ENODATA" || dnsCode === "ENOTFOUND";
yield* replace(projectId, snapshot, { issue: missingTxt ? "dns_pending" : "dns_unavailable" });
```

- `packages/zelavis/src/edge/project-domains.ts:113` `ProjectDomainIngress { dns: DnsTxtResolver; externalTarget?; preflight?; probe?; probeWithdrawal? }`.
- `packages/zelavis/src/adapters/node.ts:11` imports `createNodeDnsTxtResolver`; `:686-697` builds `projectDomainIngress` with `dns: createNodeDnsTxtResolver()`.
- `packages/zelavis/test/project-domains.test.mjs:14-27` `fixture()` injects `dns: { resolveTxt: async name => txt.get(name) ?? [] }`.

**Pattern to mirror.** The lazy, signal-aware boundary of `createNodeDnsTxtResolver` (`packages/zelavis/src/domain-verifier.ts:78-112`): Effect inside, `present(...)` at the Promise boundary, `signal` wired to cancellation, `Effect.ensuring` to detach listeners. Effect helpers come from `packages/zelavis/src/core/runtime/effect-boundary.ts` (`present`, `integration`, `evaluate`, `IntegrationFailure`).

**Traps.**
- Using `Resolver.setServers` with `resolveTxt`: c-ares hides the AA flag, CNAMEs and the authority section, which is exactly what this part needs. Use the codec.
- Calling `resolveNs(hostname)`: when the hostname is a CNAME to another zone's apex, the recursive answer names the wrong zone. Read the SOA owner from the challenge name's own response.
- Trusting a non-authoritative answer from an "authoritative" address (some servers answer with recursion): require the AA flag and RD=0.
- Unbounded compression-pointer following in the decoder: cap jumps.
- Importing `node:dgram` in `src/edge`: the codec stays pure; transport lives in `src/adapters`.

## 2. Design

**Authority and scope.** No new state. The resolver is a host binding created by the Node adapter and injected through `ProjectDomainIngress.dns`. It authorizes nothing; the controller still decides with its CAS records.

**Lookup algorithm** (`createAuthoritativeDnsTxtResolver().resolveTxt(name)` where `name` is the challenge name):
1. Ask the first recursive server (RD=1) `SOA name`. Read the zone apex: the owner of an SOA in the answer section, else the owner of the SOA in the authority section. Response codes NOERROR and NXDOMAIN both carry it. No SOA → fail `DnsLookupError({ code: "ENOTFOUND" })`.
2. Ask recursively `NS <apex>`. Keep up to 4 NS host names (answer section, owner equal to apex, sorted for determinism).
3. Ask recursively `A` then `AAAA` for each NS name until 4 addresses are collected. None → `DnsLookupError({ code: "ESERVFAIL" })`.
4. For each address in order: send `TXT name` with RD=0 over UDP to `address:authoritativePort`. Accept the first response with the AA flag set and RCODE NOERROR or NXDOMAIN. TC set → repeat that one query over TCP (2-byte length prefix). A CNAME in the answer for `name` → `DnsLookupError({ code: "ECNAME" })`. NXDOMAIN or no TXT → return `[]`. TXT → return each record's character-strings.
5. Every server timing out, refusing or answering without AA → `DnsLookupError({ code: "ESERVFAIL" })`.

Recursive servers rotate on timeout (try each of up to 3 once per step).

**Invariants.**
1. Only an AA response from an address of the zone's own NS set decides the outcome (step 4).
2. At most 3 + 1 + 8 recursive queries and 4 authoritative queries (plus one TCP retry) per lookup.
3. Each query times out after 1500 ms; the controller's existing 5-second `Effect.timeout` bounds the whole lookup and interrupts it (closing sockets through scoped finalizers).
4. Responses over 4096 bytes (UDP) or 65535 bytes (TCP) are refused; decoding follows at most 64 compression pointers and refuses names over 255 bytes.

**Failure model.** `DnsLookupError` (NEW, `Data.TaggedError("DnsLookupError")<{ code: "ENOTFOUND" | "ESERVFAIL" | "ECNAME" | "ETIMEOUT" | "EMALFORMED"; message: string }>`) crosses the Promise boundary as an `Error` whose `cause` is `{ code }`, so the existing mapping at `project-domains.ts:258-260` reads it unchanged in shape. Mapping: `ENOTFOUND` and `ECNAME` → `dns_pending` (customer must fix their record); everything else → `dns_unavailable`. Update the `missingTxt` line to include `"ECNAME"`.

**Concurrency, bounds, interruption.** The controller already limits lookups to four in flight (`dnsPermits`). Each lookup opens at most one UDP socket at a time and closes it in `Effect.acquireRelease`. Interruption by the 5-second timeout or the request signal releases the socket. A crash leaves nothing.

**Deleted.** `createNodeDnsTxtResolver` stays for `verifyDomainBindingViaDns` callers (embedding API, `domain-verifier.ts:150` onward); only the Project domain ingress switches.

**Decisions and rejected alternatives.**
- Own codec over `node:dns` `Resolver.setServers`: c-ares does not expose AA, CNAME owners or the authority SOA.
- SOA-from-authority zone discovery over walking `resolveNs` up the labels: CNAME-pointed hosts break the walk.
- Public DNS-over-HTTPS (Cloudflare 1.1.1.1, Google 8.8.8.8) rejected: it adds an outside dependency and still caches negatively.
- A third-party DNS library rejected: a few hundred lines of codec are smaller than the dependency, and the project avoids heavy dependencies (`AGENTS.md § High-Level Principles`).

**Decisions taken for the user.** CNAME at the challenge name is unsupported for now (some providers use it for delegated verification). Documented.

**Needs from the user.** None.

## 3. Contracts

**NEW** `packages/zelavis/src/edge/dns-wire.ts` (pure, no `node:` imports):

```ts
export type DnsRecordType = "A" | "AAAA" | "NS" | "CNAME" | "SOA" | "TXT";
export const DNS_TYPE: Readonly<Record<DnsRecordType, number>> = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 };
export interface DnsQuestion { readonly name: string; readonly type: DnsRecordType }
export type DnsRecordData =
  | { readonly type: "A" | "AAAA"; readonly address: string }
  | { readonly type: "NS" | "CNAME"; readonly target: string }
  | { readonly type: "SOA"; readonly primary: string }
  | { readonly type: "TXT"; readonly strings: readonly string[] }
  | { readonly type: "OTHER"; readonly code: number };
export interface DnsRecord { readonly name: string; readonly ttl: number; readonly data: DnsRecordData }
export interface DnsMessage {
  readonly id: number;
  readonly response: boolean;
  readonly authoritative: boolean;
  readonly truncated: boolean;
  readonly recursionDesired: boolean;
  readonly rcode: number; // 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, 5 REFUSED
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly DnsRecord[];
  readonly authority: readonly DnsRecord[];
}
export function encodeDnsQuery(id: number, question: DnsQuestion, recursionDesired: boolean): Uint8Array;
/** Test fixtures and the qualification harness use this to answer queries. */
export function encodeDnsResponse(message: DnsMessage): Uint8Array;
/** Throws DnsWireError on malformed input or a bound being exceeded. */
export function decodeDnsMessage(bytes: Uint8Array): DnsMessage;
export class DnsWireError extends Error { readonly _tag = "DnsWireError"; }
```

Names are lowercase, without a trailing dot, compared exactly. TXT strings decode as Latin-1 bytes to string (a TXT challenge is ASCII).

**NEW** `packages/zelavis/src/adapters/_node-authoritative-dns.ts`:

```ts
import type { DnsTxtResolver } from "../domain-verifier.js";
export interface AuthoritativeDnsOptions {
  /** "ip" or "ip:port"; default node:dns getServers(). Tests pass the fixture. */
  readonly recursiveServers?: readonly string[];
  /** Default 53. Tests pass the fixture's port. */
  readonly authoritativePort?: number;
  /** Per query; default 1500. */
  readonly queryTimeoutMs?: number;
}
export function createAuthoritativeDnsTxtResolver(options?: AuthoritativeDnsOptions): DnsTxtResolver;
```

No HTTP, SDK or CLI change: `POST /runtime/projects/:projectId/domains/:hostname/verify` keeps its contract.

## 4. Execution steps

### 1. Prove the domain baseline at HEAD

- **Goal**: confirm the suites this part touches pass before editing.
- **Files**: none changed.
- **Change**: build and run.
- **Depends on**: none.
- **Check**: from the repository root, `pnpm --filter zelavis run build; echo "exit $?"` then `pnpm --filter zelavis exec node --test --test-reporter=dot test/project-domains.test.mjs test/domain-verifier.test.mjs test/platform-public-domain-forwarding.test.mjs; echo "exit $?"`. Both print `exit 0`. Loopback listeners need the sandbox's network permission.

### 2. Add the runtime-neutral DNS wire codec

- **Goal**: encode queries and responses and decode responses per RFC 1035 within the bounds of section 2.
- **Files**: **NEW** `packages/zelavis/src/edge/dns-wire.ts`; **NEW** `packages/zelavis/test/dns-wire.test.mjs`.
- **Context**: Header is 12 bytes: id, flags (QR bit 15, AA bit 10, TC bit 9, RD bit 8, RCODE low 4 bits), QDCOUNT, ANCOUNT, NSCOUNT, ARCOUNT. Names are length-prefixed labels; a byte with the top two bits set starts a 14-bit compression pointer. TXT RDATA is one or more length-prefixed character-strings. `encodeDnsResponse` does not need compression.
- **Change**: implement the section 3 exports with `DataView`. Labels 1-63 bytes, names ≤ 255 bytes, ≤ 64 pointer jumps, ≤ 256 records per section, input ≤ 65535 bytes. Unknown types decode to `{ type: "OTHER", code }`. No imports.
- **Depends on**: 1.
- **Check**: tests (section 5, file `dns-wire.test.mjs`) after `pnpm --filter zelavis run build`: `pnpm --filter zelavis exec node --test test/dns-wire.test.mjs; echo "exit $?"` prints `exit 0`.

### 3. Add the authoritative DNS test fixture

- **Goal**: a local UDP and TCP DNS server that plays both a recursive resolver and authoritative servers for test zones.
- **Files**: **NEW** `packages/zelavis/test/_dns-authority.mjs`.
- **Context**: Tests cannot bind port 53, so the resolver takes `authoritativePort`. NS addresses in the fixture are `127.0.0.1`; the authoritative port is the fixture's own port.
- **Change**: export `startDnsAuthority(t, { zones })`, where `zones` is `Map<apex, { ns: string[], records: Map<"name|TYPE", DnsRecordData[]>, authoritative?: boolean }>`. It binds UDP and TCP on `127.0.0.1:0` (same port), answers with `encodeDnsResponse` from `../dist/edge/dns-wire.js`: for RD=1 queries it acts as a recursive resolver (answers any zone, sets AA=0, adds the governing SOA to authority on NXDOMAIN/NODATA, and caches negative answers until `t` ends unless `noNegativeCache` is set, which is the point); for RD=0 queries it answers authoritatively (AA=1) for its zones. It exposes `{ address: "127.0.0.1:<port>", port, set(name, type, data[]), remove(name, type), queries: Array<{ name, type, rd }>, dropAuthoritative(boolean), truncateAuthoritative(boolean) }`, and closes in `t.after`. Imports: `import { createSocket } from "node:dgram"; import { createServer } from "node:net"; import { encodeDnsResponse, decodeDnsMessage } from "../dist/edge/dns-wire.js";`.
- **Depends on**: 2.
- **Check**: exercised by step 4's tests.

### 4. Add the Node authoritative TXT resolver

- **Goal**: `createAuthoritativeDnsTxtResolver` per section 2.
- **Files**: **NEW** `packages/zelavis/src/adapters/_node-authoritative-dns.ts`; **NEW** `packages/zelavis/test/authoritative-dns.test.mjs`.
- **Context**: mirror the boundary of `createNodeDnsTxtResolver` (`packages/zelavis/src/domain-verifier.ts:78-112`). Imports for the new adapter file:

```ts
import { createSocket } from "node:dgram";
import { connect } from "node:net";
import { getServers } from "node:dns";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { present, integration } from "../core/runtime/effect-boundary.js";
import { decodeDnsMessage, encodeDnsQuery, type DnsMessage, type DnsQuestion } from "../edge/dns-wire.js";
import type { DnsTxtResolver } from "../domain-verifier.js";
```

- **Change**: implement `udpQuery(server, question, rd)` and `tcpQuery(...)` as `Effect.acquireRelease` around the socket, with `Effect.timeout(queryTimeoutMs)` mapped to `DnsLookupError({ code: "ETIMEOUT" })`; random 16-bit ids from `crypto.getRandomValues`; reject a response whose id or question differs. Implement the five steps of section 2 with `Effect.gen`. `resolveTxt(name, signal)` returns `present(lookup(name).pipe(...))` with the signal wired to interruption (as the pattern does). Convert `DnsLookupError` at the boundary to `new Error(message, { cause: { code } })`. No `async`, no `new Promise`.
- **Depends on**: 3.
- **Check**: after building, `pnpm --filter zelavis exec node --test test/authoritative-dns.test.mjs; echo "exit $?"` prints `exit 0`, with the cases in section 5.

### 5. Use it for Project domain verification

- **Goal**: Project domains verify against authoritative servers in Node deployments.
- **Files**: `packages/zelavis/src/adapters/node.ts:11`, `:687`; `packages/zelavis/src/edge/project-domains.ts:258-260`; `packages/zelavis/test/project-domains.test.mjs`.
- **Change**: in `node.ts` add `import { createAuthoritativeDnsTxtResolver } from "./_node-authoritative-dns.js";`, replace `dns: createNodeDnsTxtResolver(),` with `dns: createAuthoritativeDnsTxtResolver(),`, and remove the now-unused `createNodeDnsTxtResolver` import if nothing else in the file uses it (check with `rg createNodeDnsTxtResolver packages/zelavis/src/adapters/node.ts`). In `project-domains.ts` change the `missingTxt` condition to `error instanceof DnsTxtProofMissing || dnsCode === "ENODATA" || dnsCode === "ENOTFOUND" || dnsCode === "ECNAME"`. In `project-domains.test.mjs` add the controller cases of section 5 using `startDnsAuthority` and `createAuthoritativeDnsTxtResolver` (import from `../dist/adapters/_node-authoritative-dns.js`), with an injected `now` to pass `RETRY_MS`.
- **Depends on**: 4.
- **Check**: rebuild, then `pnpm --filter zelavis exec node --test test/project-domains.test.mjs test/authoritative-dns.test.mjs test/domain-verifier.test.mjs; echo "exit $?"` prints `exit 0`.

### 6. Document the lookup and its limits

- **Goal**: operators and customers know where the TXT is read and what is unsupported.
- **Files**: `website/src/content/docs/architecture/edge.md:80-95`.
- **Change**: after the TXT step, state that Zelavis reads the record from the domain's authoritative nameservers, so it can be checked again as soon as the DNS provider has published it (30 seconds between checks still applies); a CNAME at `_zelavis-challenge.<hostname>` is not followed; DNSSEC is not validated; a verified domain is not re-checked later.
- **Depends on**: 5.
- **Check**: from the root, `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 7. Self-audit

- **Goal**: the part matches its Done means.
- **Change**: follow the self-audit list in section 8.
- **Check**: `pnpm run verify; echo "exit $?"` and `git diff --check; echo "exit $?"` print `exit 0`.

## 5. Tests

`packages/zelavis/test/dns-wire.test.mjs` (node:test, imports `../dist/edge/dns-wire.js`):
- Round trip: encode a response with A, AAAA, NS, CNAME, SOA and multi-string TXT; decode equals input (names lowercased).
- Compression: a hand-built response using pointers decodes; a pointer loop throws `DnsWireError`; a 256-byte name throws; a truncated buffer throws.
- Query encoding sets RD as requested and one question.

`packages/zelavis/test/authoritative-dns.test.mjs` (uses `startDnsAuthority`, `createAuthoritativeDnsTxtResolver({ recursiveServers: [fixture.address], authoritativePort: fixture.port })`):
- **Negative cache bypass**: arrange zone `example.com` with no challenge record; act: resolve `_zelavis-challenge.shop.example.com` → `[]`; `fixture.set(...)` the TXT; resolve again; assert the token is returned and `fixture.queries` holds two RD=0 TXT queries (the recursive side cached the NXDOMAIN, the resolver never asked it for TXT).
- **CNAME-pointed host**: `shop.example.com` is a CNAME to `ingress.host.net` (another fixture zone apex `host.net`); TXT lives at `_zelavis-challenge.shop.example.com` in `example.com`; assert the token is returned and no query went to `host.net`'s data for the challenge.
- **Delegated child zone**: zones `example.com` and `eu.example.com`; challenge under `app.eu.example.com`; assert the answer comes from the `eu.example.com` zone record.
- **CNAME at challenge**: answer contains a CNAME for the challenge name → rejects with an Error whose `cause.code === "ECNAME"`.
- **Non-authoritative answer refused**: zone flagged `authoritative: false` (fixture answers RD=0 with AA=0) → `cause.code === "ESERVFAIL"`.
- **Timeout**: `dropAuthoritative(true)`; with `queryTimeoutMs: 200`, rejects `ESERVFAIL` within 2 seconds after trying every address.
- **Truncation**: `truncateAuthoritative(true)` makes UDP answers TC; the TCP retry returns the token.
- **Abort**: an aborted `AbortSignal` rejects promptly and leaves no open handle (`node --test` exits).

`packages/zelavis/test/project-domains.test.mjs` additions (controller with the real resolver against the fixture):
- Verify before the record exists → `ProjectDomainError` `dns_not_verified`, stored `issue: "dns_pending"`; add record; advance `now` by 30 s; verify → state `verified`.
- Authorities dropped → `issue: "dns_unavailable"`.

Command: `pnpm --filter zelavis exec node --test test/dns-wire.test.mjs test/authoritative-dns.test.mjs test/project-domains.test.mjs`. No browser change in this part, so no browser test; the Domains page behavior is unchanged.

## 6. Docs and project notes

`website/src/content/docs/architecture/edge.md` (step 6). No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run docs:check`, `git diff --check`. If host-operation tests fail on the `/tmp` symlink, rerun with `TMPDIR=/private/tmp/zelavis-verify`.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely on against the code before its step. Adapt a stale step to the current code and record the deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing someone else's work. First read every entry under `## Execution report`. Then confirm the last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff` on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]` lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another agent may still be working on it. Check, do not ask: if this plan file, or any file a step's Files line names, changed in the last 15 minutes, end the session with one line saying the plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you change its first file, and `[x]` with the date and a one-line note as soon as its check passes, before you start the next step. Never mark `[x]` a step whose check you did not see pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of required checks during the current step. Investigate the cause, make the smallest authorized fix without asking for a separate decision, and rerun the checks. A required test that flakes and leaks resources is work to fix now. The Files line tells you where to start. Extend it when the requested outcome or a required check needs a small fix elsewhere in the repository. Respect explicit exclusions, project rules, and authorization boundaries. Record a meaningful deviation in the execution report. Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract that needs its own design, or unavailable access or authorization can block required work. Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step. Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]` and name what must happen first and how to verify completion. Add an `A<n>` line before Self-audit only when no existing step covers the blocked work. Continue with independent steps. Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step, in order, and run each step's check before starting the next. Tests you write are run in the same step, before you move on. Keep changes tied to the requested outcome and its checks. Match the surrounding code's style, naming and comment density. Work in the main checkout on `dev`; create no worktree and no branch.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols and adapt the step when its intended outcome still holds. Follow project rules and record any conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; literal unlimited Effect concurrency; unchecked `JSON.parse` casts; new `async` functions, `new Promise` or Promise coordination in Platform code, and any growth of `scripts/effect-migration-baseline.json`; `node:` imports outside `src/adapters` (and the CLI); the `effect` barrel in files the Project persistent host loads; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; secrets in logs, responses or security events. Never edit generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every change supports the requested outcome or its required checks, and other people's changes are preserved;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary files and TODOs you added;
> - ordinary omissions and check failures found in the audit have been resolved;
> - no `[ ]` or `[~]` line is left above Self-audit, and any `[!]` names a concrete prerequisite.
> Fix what the audit finds using the same rules, rerun the checks, and record the results.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their text lives in `## Progress`.
>
> Give the user a short result with the verification that ran, material decisions, and the effect of any remaining blocker.

## Execution report
