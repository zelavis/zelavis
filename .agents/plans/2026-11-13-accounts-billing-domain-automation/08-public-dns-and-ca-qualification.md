# Public DNS and CA qualification for Project domains

Job: Qualify Project domain ownership (TXT proof), routing and certificates against a real public DNS zone and Let's Encrypt staging, with a committed, repeatable script.
Date: 2026-11-13
Status: done
Verified-at: b04fa02d95
Part: 8 of 14. Read 00-overview.md first.

To start:    Execute part 8 in .agents/plans/2026-11-13-accounts-billing-domain-automation/08-public-dns-and-ca-qualification.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/08-public-dns-and-ca-qualification.md. Start with its section 8.

## Progress

- [x] 1. Confirm parts 1 and 7 and the remote-qualification pattern. (2026-11-16, Zelavis package build passed.)
- [x] 2. Write the qualification script and its local self-test. (2026-11-16, workspace build and all five self-test legs passed.)
- [x] 3. Run the manual TXT and HTTP-01 leg against the real zone. (2026-11-17: run `1bluwknkn4m` printed both PASS lines on zelavis.com; recursive 8.8.8.8 remained negative across authoritative verification, and the Mac verified staging HTTPS.)
- [x] 4. Run the automatic subdomain and wildcard DNS-01 leg. (2026-11-17: run `1bluwknkn4m` printed PASS dns-01-wildcard, automatic and cleanup, then QUALIFIED; exit 0.)
- [x] 5. Record the evidence and update the docs' qualification statements. (2026-11-17: Edge docs describe the staging proof and retain the production-CA limit; docs:check passed.)
- [x] 6. Self-audit. (2026-11-17: full verify, ci:ui, self-test, focused regression, docs and whitespace checks passed; independent VPS cleanup/PID check passed.)

## 0. Summary and finish line

The earlier VPS run proved HTTP-01 issuance and renewal through Let's Encrypt staging with a disposable `sslip.io` hostname, but the Project's TXT ownership proof went through an injected test resolver, because `sslip.io` cannot hold arbitrary TXT records. This part commits `distribution/scripts/qualify-domains.mjs` (`pnpm release:qualify:domains`), which uses a real zone the owner controls: it creates and deletes the records through the part 7 built-in Cloudflare driver, runs a packed candidate on a disposable environment on the existing VPS, and proves (1) TXT proof read from the authoritative servers, including the verify-before-record case, (2) HTTP-01 issuance for a customer domain, (3) an automatic hosted subdomain, and (4) a DNS-01 wildcard certificate, then removes everything.

- **In scope**: the script, a self-test against local fixtures, one live run, evidence, docs.
- **Out of scope**: adding the script to `release:check` (it needs secrets and a public address, like `ZELAVIS_QUALIFY_SHARDS_AGENT_SSH`, which is not a release gate), production certificates.
- **Done means**: (a) `--self-test` passes locally with no network beyond loopback; (b) one live run printed `PASS` for `manual-txt`, `http-01`, `automatic`, `dns-01-wildcard` and `cleanup`, recorded in this file's execution report with the date, commit and zone (no token); (c) off-host HTTPS clients verified the staging chain for both certificates; (d) no record, unit, address or redirect remained afterwards, and the VPS's existing Zelavis and Traefik processes kept their PIDs; (e) `pnpm run verify` and `pnpm run docs:check` pass.
- **Supplement**: updated in this run (overview section 0).
- **Sources read**: `AGENTS.md § GitHub Zero-Spend Policy` (owner's Mac or disposable VPS environments for extra qualification), `§ Verification`; `distribution/scripts/qualify-shards.mjs`; `distribution/scripts/runtime-assets.mjs`; parts 1 and 7; the removed plan's Part 5 report (summarized below).

## 1. Context packet

**Glossary.**
- **Run id**: `process.pid.toString(36)` plus a timestamp suffix; every name the run creates contains it.
- **Leg**: one independent proof in the script; legs run in order and each cleans up after itself, with a final sweep.
- **Disposable environment**: everything the run creates on the VPS under `/var/tmp/zv-domains-<run>`, transient systemd units `zv-domains-<run>-*`, one temporary IPv6 address and destination-scoped nftables redirects, all removed at the end.

**Governing rules.**
> "macOS/ARM qualification and extra installer/provisioning checks belong on the owner's Mac or in disposable environments on the existing VPS. Never direct untrusted public pull-request code to the everyday Mac or production VPS." `AGENTS.md § GitHub Zero-Spend Policy`
>
> "Primitive proofs alone do not qualify a release" `AGENTS.md § Platform And App Service Boundary` (why a live run is required).

**System today.**
- Remote-qualification pattern `distribution/scripts/qualify-shards.mjs:14-19` (env `ZELAVIS_QUALIFY_SHARDS_AGENT_SSH`, `..._SSH_KEY`), `:46-80` (pack with `pnpm --filter zelavis pack`, `scp`, unpack under `/var/tmp`, `npm install --omit=dev --ignore-scripts`, `systemd-run --unit … --uid=nobody`, SSH tunnel for the API, teardown `systemctl stop` + `rm -rf`).
- Pinned Traefik download: `installTraefikRuntime` in `distribution/scripts/runtime-assets.mjs` (used by `build-stage.mjs:158`).
- Part 1: `createAuthoritativeDnsTxtResolver` is what Project domains use in Node (`packages/zelavis/src/adapters/node.ts`); `test/_dns-authority.mjs` fixture.
- Part 7: the built-in Cloudflare driver (`createCloudflareDnsProvider` in `packages/zelavis/src/adapters/_dns-cloudflare.ts`), DNS connections, adopted zones, `POST /runtime/edge/dns/zones/:apex/wildcard-certificate`, `dns: "automatic"` Project domains.
- Project domain API: `GET|POST /runtime/projects/:projectId/domains`, `POST …/:hostname/verify`, `DELETE …/:hostname?revision=N` (`packages/zelavis/src/platform/project-domain-routes.ts`).
- Earlier run (removed plan, Part 5 report, 2026-11-12): packed candidate and Traefik 3.7.13 under an unprivileged transient unit; a temporary IPv6 address with destination-scoped redirects to ports 80/443; Let's Encrypt staging validated HTTP-01; named and bulk renewal served new leaves; off-host clients verified the staging chain; a native App accepted signup with an HttpOnly cookie and denied its admin Auth route; withdrawal removed the route and certificate; existing processes kept their PIDs.

**Pattern to mirror.** `qualify-shards.mjs` in full for SSH, packing, transient units, `ZELAVIS_QUALIFY_KEEP`, and failure collection (`failures` array, nonzero exit).

**Traps.**
- Printing or passing the token on a command line (visible in `ps` on both machines): read it from the environment locally; send it to the remote Platform only through the API over the SSH tunnel (`PUT /runtime/edge/dns/connections/cloudflare`).
- Testing verify-before-record with a resolver that never saw the name: query the name once through a public recursive resolver (`1.1.1.1`) before creating the record, to seed a negative cache, which is the real-world failure part 1 fixes.
- Trusting the staging root on the machine: confine it to the test client process (`NODE_EXTRA_CA_CERTS` for one `node` invocation, or `curl --cacert`).
- Leaving records on failure: register every created record id in an in-memory cleanup list immediately and delete in `finally`; the final sweep also lists records named with the run id.
- Touching the VPS's existing Zelavis or Traefik: bind only the temporary IPv6 address; read their PIDs before and after.

## 2. Design

**Inputs** (environment, all required for live runs): `ZELAVIS_QUALIFY_DOMAINS_SSH` (`user@host`, root needed for `ip`, `nft`, `systemd-run`), `ZELAVIS_QUALIFY_DOMAINS_SSH_KEY` (optional), `ZELAVIS_QUALIFY_DOMAINS_ZONE` (apex the token can edit), `ZELAVIS_QUALIFY_DOMAINS_CLOUDFLARE_TOKEN`, `ZELAVIS_QUALIFY_DOMAINS_IPV6` (a free address in the VPS's routed prefix), `ZELAVIS_QUALIFY_DOMAINS_IFACE` (interface for it), `ZELAVIS_QUALIFY_KEEP=1` (keep remote files after failure). `--self-test` needs none.

**Live sequence.**

Live-run adjustment (2026-11-17): `ZELAVIS_QUALIFY_DOMAINS_RECURSIVE_IPV4` optionally chooses the public recursive resolver (default `1.1.1.1`). The first DNS run found that `1.1.1.1` already returned the new TXT after 31 seconds, so the next run uses `8.8.8.8`. The strict negative-answer assertions before and after authoritative verification remain required. References to `1.1.1.1` in this sequence mean the configured resolver.
1. Preflight: SSH reachable; record PIDs of existing `zelavis*` and `traefik` units; confirm the address is unused (`ip -6 addr show`); confirm the token lists the zone.
2. Remote setup: pack, upload, unpack under `/var/tmp/zv-domains-<run>`; install pinned Traefik there via `installTraefikRuntime` logic (download locally, `scp`); add the IPv6 address; add an nftables table `zv_domains_<run>` that redirects `[addr]:80` and `[addr]:443` to the test Traefik ports; start the Platform (`systemd-run --uid=nobody`, Edge adapter Traefik on those ports, ACME directory Let's Encrypt staging, management on `127.0.0.1:<port>`) and tunnel the API.
3. Bootstrap the owner through `/auth/bootstrap`, create a native App Project.
4. Leg `manual-txt`: hostname `m-<run>.<zone>`; create AAAA → the IPv6 address; seed a negative cache by querying `_zelavis-challenge.m-<run>.<zone>` TXT at `1.1.1.1`; add the domain (`tlsMode: "managed"`); verify → expect `dns_not_verified`; create the TXT record; wait 31 s; verify → expect `verified` (proves the authoritative read while `1.1.1.1` still caches NXDOMAIN: assert with a `dig @1.1.1.1` style query through the part 1 codec that the public resolver still answers empty, else note "cache not seeded" and fail the leg's strictness check).
5. Leg `http-01`: wait for `active` (bounded 5 min); from the local machine, `https://m-<run>.<zone>/` with the staging root only in that client; expect the App site; App signup works and returns an HttpOnly cookie; the App admin Auth route is refused there.
6. Leg `automatic`: connect Cloudflare through the API (token in the request body over the tunnel); adopt the zone with `hostedSubdomains: true`, targets `aaaa: [addr]`; order the wildcard (`dns-01-wildcard` leg) and wait for it; add `a-<run>` automatic; expect `active`; fetch `https://a-<run>.<zone>/` with the staging root; certificate SAN is `*.<zone>`.
7. Leg `cleanup`: remove both domains, release the zone, disconnect; list records for names containing the run id → none; stop units, remove nftables table and address, delete `/var/tmp/zv-domains-<run>`; compare existing PIDs.

**Self-test.** Runs legs 4-7's logic locally: the part 1 DNS fixture plays the zone's authority, a fake Cloudflare API (an HTTP server answering the four endpoints) writes into it, the Platform runs locally with the in-repo ACME test fixture (the one `test/edge-certificates.test.mjs` uses) instead of Let's Encrypt, and HTTPS is checked against the fixture CA. It proves the harness, not the real world.

**Bounds.** Each wait has a deadline (DNS 31 s per check with at most 10 checks, issuance 5 min, HTTP 30 s); total live run under 30 minutes; every remote command through `spawnSync` with a 120 s timeout.

**Decisions and rejected alternatives.** Cloudflare over a DNS provider without API: the record lifecycle must be scripted. IPv6 on the VPS over a second machine: matches the earlier proven approach and costs nothing. Not a release gate: secrets and a public address.

**Decisions taken for the user.** Hostname prefixes `m-` and `a-` with the run id; records TTL 60.

**Needs from the user.** The Cloudflare token, zone, SSH target, free IPv6 address and interface (overview § Needs from the user). Steps 3–5 wait for them. The token must be able to list the target zone and edit its records. [Cloudflare List Zones](https://developers.cloudflare.com/api/resources/zones/methods/list/)

## 3. Contracts

Root `package.json` script: `"release:qualify:domains": "node distribution/scripts/qualify-domains.mjs"`. Exit 0 with a `PASS <leg>` line per leg and `QUALIFIED <commit>`; exit 1 with `FAIL <leg>: <reason>` lines. No HTTP, SDK or CLI change.

## 4. Execution steps

### 1. Confirm parts 1 and 7 and the remote-qualification pattern

- **Files**: none.
- **Change**: `rg -n "createAuthoritativeDnsTxtResolver" packages/zelavis/src/adapters/node.ts`; `rg -n "createCloudflareDnsProvider" packages/zelavis/src/adapters`; read `distribution/scripts/qualify-shards.mjs` in full.
- **Depends on**: parts 1, 7.
- **Check**: `pnpm --filter zelavis run build; echo "exit $?"` prints `exit 0`.

### 2. Write the qualification script and its local self-test

- **Files**: NEW `distribution/scripts/qualify-domains.mjs`; NEW `distribution/scripts/domains/fake-cloudflare.mjs`; root `package.json` (script).
- **Change**: section 2, sharing one leg implementation between live and self-test modes (the environment object differs). Imports from the built package (`packages/zelavis/dist/...`) for the DNS codec and from `packages/zelavis/dist/adapters/_dns-cloudflare.js` for the client (`createCloudflareDnsProvider({ apiBase })` points it at the fake in self-test mode).
- **Depends on**: 1.
- **Check**: `pnpm run build; node distribution/scripts/qualify-domains.mjs --self-test; echo "exit $?"` prints the five `PASS` lines and `exit 0`.

### 3. Run the manual TXT and HTTP-01 leg against the real zone

- **Depends on**: 2 and the user's prerequisites.
- **Check**: `ZELAVIS_QUALIFY_DOMAINS_SSH=… ZELAVIS_QUALIFY_DOMAINS_ZONE=… ZELAVIS_QUALIFY_DOMAINS_CLOUDFLARE_TOKEN=… ZELAVIS_QUALIFY_DOMAINS_IPV6=… ZELAVIS_QUALIFY_DOMAINS_IFACE=… pnpm release:qualify:domains; echo "exit $?"` prints `PASS manual-txt`, `PASS http-01`. Investigate any failure as a product defect first (fix in part 1 or 7 code with tests), then rerun.

### 4. Run the automatic subdomain and wildcard DNS-01 leg

- **Depends on**: 3.
- **Check**: the same run prints `PASS dns-01-wildcard`, `PASS automatic`, `PASS cleanup`, `QUALIFIED <commit>` and `exit 0`.

### 5. Record the evidence and update the docs' qualification statements

- **Files**: this file's execution report; `website/src/content/docs/architecture/edge.md` (where it lists what is qualified).
- **Change**: state the date, commit, zone (no token), legs, and that a real public TXT record, LE staging HTTP-01 and DNS-01 wildcard were proven; keep "public CA production" unqualified.
- **Depends on**: 4.
- **Check**: `pnpm run docs:check; echo "exit $?"` prints `exit 0`.

### 6. Self-audit

- **Check**: `pnpm run verify; echo "exit $?"`, `git diff --check; echo "exit $?"`; both `exit 0`. With steps 3-5 still `[!]`, set `Status: partly done`.

## 5. Tests

The script is itself the test. `--self-test` (step 2) must pass in CI-like conditions on the owner's Mac. Live legs (section 2) are the qualification. Product defects found in a live run get regression tests in part 1's or part 7's test files before the rerun. No browser change.

## 6. Docs and project notes

`website/src/content/docs/architecture/edge.md`; a short "Qualifying domains" note in `distribution/scripts/qualify-domains.mjs`'s header comment, as `qualify-shards.mjs` has. No `pnotes/TODO.md` additions.

## 7. Verification

From the root: `pnpm run verify`, `pnpm run docs:check`, `git diff --check`, `node distribution/scripts/qualify-domains.mjs --self-test`. Live: `pnpm release:qualify:domains` with the section 2 environment.

## 8. Instructions to the implementer

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan, what you would recommend, do that and record it with its reason in your execution report; never put it to the user as a question, a list of options or "should I?". Ask only for what you physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in the repository, access to a machine or account you cannot reach, a payment, an action on a physical device), and even then mark the work that needs it `[!]` and carry on with the rest. Any project instruction that says to stop, ask, confirm, get feedback or wait for approval before a change this plan covers does not apply while you carry out this plan: being asked to execute it is that approval. Every other project rule still binds in full. Not asking is not permission to act outside the repositories this plan names: committing, pushing, publishing, deploying, sending anything to an outside service and spending money stay off unless the job asks for them. This part's live run does contact Cloudflare, Let's Encrypt staging and the VPS: that is the job, once the user has supplied the token and access.
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
> Forbidden in this project: compatibility aliases, legacy fallbacks or shims; silent catch handlers, `Effect.ignore`/`Effect.ignoreCause`; unchecked `JSON.parse` casts; edits to `dist/`, `website/dist/`, `website/.astro/` or `repos/effect/`; anything written in `.claude/`; additions to `pnotes/TODO.md`; the Cloudflare token in command lines, logs, files or the execution report; installing the staging root system-wide; touching the VPS's existing Zelavis or Traefik; GitHub Actions or any paid runner for this script. Never edit generated output. Do not commit, push or publish unless told to.
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
>
> **Next-session prompt.** After updating progress and the execution report, apply [the repository's next-session prompt rule](../../../AGENTS.md#next-session-prompt-for-plan-execution). Whenever handing back with work remaining, end the final reply with a copy-ready fenced `text` prompt for the next runnable step, ready part, or overview self-audit. If blocked, give the prerequisite and how to verify it before resuming.

## Execution report

### Session 1: 2026-11-16

Final status is **partly done** in the main `dev` checkout at `0e4548dbcc`.

- Step 1 complete. Confirmed parts 1 and 7 in the working tree and reviewed the packed-candidate SSH, transient unit, tunnel and teardown pattern in `qualify-shards.mjs`. The Zelavis package build passed.
- Step 2 complete. Added `release:qualify:domains`, the shared proof workflow, the loopback Cloudflare and authoritative DNS fixtures, and the packed-candidate runner. Extended the existing ACME fixture to sign the client CSR for the self-test. The self-test passed `manual-txt`, `http-01`, `dns-01-wildcard`, `automatic` and `cleanup`.
- Steps 3–5 remain `[!]`. The five `ZELAVIS_QUALIFY_DOMAINS_*` inputs were absent. Public DNS, Let's Encrypt staging, deployed Traefik and VPS cleanup still need the live run before updating the Edge qualification statements.
- Step 6 complete. `pnpm run build`, `node distribution/scripts/qualify-domains.mjs --self-test`, `TMPDIR=/private/tmp/zelavis-verify pnpm run verify`, `pnpm run docs:check` and `git diff --check` passed. The Zelavis suite reported 3,289 passes and 30 skips. Checked syntax and whitespace in the untracked JavaScript files separately. Live mode with the inputs missing exited 1 at preflight.

Decisions and adjustments:

- The local runner uses a loopback TLS proxy and the existing ACME fixture with a temporary CA. It checks the served leaf and hostname through a client with scoped CA trust. `QUALIFIED` is reserved for the live run.
- The site check expects the native App's 503 HTML placeholder because the Project has no frontend installed. Signup and the Auth admin denial independently exercise public routing. The disposable proxy uses the HTTP fallback for initial ACME and checks withdrawal over HTTPS.
- The remote runner uses destination-scoped IPv6 port translation and a private management tunnel. A write journal records each provider create intent and returned ID so the final sweep can identify the run's value on the shared wildcard challenge name.
- The live Cloudflare token needs Zone Read as well as DNS Edit. The built-in driver lists zones before adopting the selected one.

Added items: none.

### Session 2: 2026-11-17

Final status is **done** in the main `dev` checkout. The live run qualified the
packed working-tree candidate based on `0e4548dbcc9d2a6c4bb29f6af2d222cfdb55d7e5`.

- Steps 1–2 rechecked: the package build and all five loopback self-test legs passed.
- Step 3 done differently: run `1bluwknkn4m` used real records on `zelavis.com` and recursive resolver `8.8.8.8`. Verification before the TXT existed failed; authoritative verification then succeeded while the recursive answer remained negative before and after it. Let's Encrypt staging HTTP-01 issuance passed. The Mac verified the served staging chain and exact hostname, native App placeholder, signup with a Secure HttpOnly cookie and refusal of the administrative Auth route.
- Step 4 done: the same run passed real Cloudflare DNS-01 wildcard issuance and automatic AAAA/subdomain routing. The Mac verified the wildcard certificate chain and `*.zelavis.com` SAN. The complete run printed `PASS manual-txt`, `PASS http-01`, `PASS dns-01-wildcard`, `PASS automatic`, `PASS cleanup`, then `QUALIFIED 0e4548dbcc9d2a6c4bb29f6af2d222cfdb55d7e5`, and exited 0.
- Step 5 done: Edge architecture docs now record the public TXT and staging HTTP-01/DNS-01 proof, retaining the unqualified public-production-CA limit. `pnpm run docs:check` passed.
- Step 6 done: `TMPDIR=/private/tmp/zelavis-verify pnpm run verify` passed (Zelavis: 3,311 passes, 30 skips, zero failures); `pnpm run ci:ui`, the two focused resolution/host-footprint test files (7 passes), `node distribution/scripts/qualify-domains.mjs --self-test`, syntax checks and `git diff --check` passed. Browser qualification included DNS automation and registrar flows at desktop/mobile sizes. No code was committed, pushed or published.

Failures investigated and deviations:

- Run `17chwkn4ibh` failed during native Project creation because the bundled Marketplace allow-list import had not registered host-provided package resolution. Fixed the import boundary in `_marketplace-allowlist.ts` using the existing `provideHostPackagesTo` mechanism. Added an isolated unpacked-distribution regression in `service-resolution.test.mjs`; it reproduced `ERR_MODULE_NOT_FOUND` before the fix and passed afterwards. The persistent Project host footprint still passes. This extends the plan's Files scope to resolve a defect blocking its live check.
- Run `18yqwkng3hp` reached the real TXT leg, but `1.1.1.1` returned the new record after 31 seconds, so the required stale-cache proof failed. Added the optional validated `ZELAVIS_QUALIFY_DOMAINS_RECURSIVE_IPV4` input (default `1.1.1.1`) and recorded the configured resolver in the run header. The successful retry used `8.8.8.8`; the strict negative-answer assertions remain unchanged. Both failed runs cleaned up; the second printed `PASS cleanup`.
- The final cleanup checked removal of all run-owned DNS records, including wildcard challenge records, stopped both disposable units and removed the address, nftables redirects and remote tree. An independent SSH check confirmed no `zv-domains-1bluwknkn4m*` units, no temporary nftables table, only the original global IPv6 on `eth0`, and no run directory. Production PIDs remained `1365165` (Platform), `97642` (Traefik), `1365164` (Agent), and `1365129` (host Agent).

Decisions taken for the user: used the confirmed VPS `138.199.147.126` with the unused
`2a01:4f8:c17:5785::d09a/128` on `eth0` and generated `m-`/`a-` run hostnames, keeping
the qualification destination separate from existing listeners. Used Google Public
DNS only for the stale recursive-cache proof after the default resolver failed that
precondition. The encrypted SSH key was unlocked in an isolated temporary agent;
the agent and its directory were removed after cleanup. Credentials were delivered
through one-use secure inputs, consumed and deleted, and were not recorded here.

Added items: none.
