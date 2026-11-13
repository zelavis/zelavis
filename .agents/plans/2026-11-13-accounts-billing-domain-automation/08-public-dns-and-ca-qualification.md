# Public DNS and CA qualification for Project domains

Job: Qualify Project domain ownership (TXT proof), routing and certificates against a real public DNS zone and Let's Encrypt staging, with a committed, repeatable script.
Date: 2026-11-13
Status: planned
Verified-at: b04fa02d95
Part: 8 of 10. Read 00-overview.md first.

To start:    Execute part 8 in .agents/plans/2026-11-13-accounts-billing-domain-automation/08-public-dns-and-ca-qualification.md. Read 00-overview.md first, then start with the part's section 8.
To continue: Continue the plan in .agents/plans/2026-11-13-accounts-billing-domain-automation/08-public-dns-and-ca-qualification.md. Start with its section 8.

## Progress

- [ ] 1. Confirm parts 1 and 7 and the remote-qualification pattern.
- [ ] 2. Write the qualification script and its local self-test.
- [!] 3. Run the manual TXT and HTTP-01 leg against the real zone. (blocked by: Cloudflare token with Zone.DNS:Edit, zone name, SSH to a disposable VPS environment, a free public IPv6 address on it; check: the script's leg 1 prints `PASS manual-txt` and `PASS http-01`)
- [!] 4. Run the automatic subdomain and wildcard DNS-01 leg. (blocked by: same as step 3; check: leg 2 prints `PASS automatic` and `PASS dns-01-wildcard`)
- [!] 5. Record the evidence and update the docs' qualification statements. (blocked by: steps 3-4; check: `pnpm run docs:check` exits 0 and this file's report names the run)
- [ ] 6. Self-audit.

## 0. Summary and finish line

The earlier VPS run proved HTTP-01 issuance and renewal through Let's Encrypt staging with a disposable `sslip.io` hostname, but the Project's TXT ownership proof went through an injected test resolver, because `sslip.io` cannot hold arbitrary TXT records. This part commits `distribution/scripts/qualify-domains.mjs` (`pnpm release:qualify:domains`), which uses a real zone the owner controls: it creates and deletes the records through the part 7 Cloudflare client, runs a packed candidate on a disposable environment on the existing VPS, and proves (1) TXT proof read from the authoritative servers, including the verify-before-record case, (2) HTTP-01 issuance for a customer domain, (3) an automatic hosted subdomain, and (4) a DNS-01 wildcard certificate, then removes everything.

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
- Part 7: `@zelavis/dns-cloudflare` (`zelavis-services/dns-cloudflare/src/cloudflare-dns.ts`), DNS connections, adopted zones, `POST /runtime/edge/dns/zones/:apex/wildcard-certificate`, `dns: "automatic"` Project domains.
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

**Needs from the user.** The Cloudflare token, zone, SSH target, free IPv6 address and interface (overview § Needs from the user). Steps 3-5 wait for them.

## 3. Contracts

Root `package.json` script: `"release:qualify:domains": "node distribution/scripts/qualify-domains.mjs"`. Exit 0 with a `PASS <leg>` line per leg and `QUALIFIED <commit>`; exit 1 with `FAIL <leg>: <reason>` lines. No HTTP, SDK or CLI change.

## 4. Execution steps

### 1. Confirm parts 1 and 7 and the remote-qualification pattern

- **Files**: none.
- **Change**: `rg -n "createAuthoritativeDnsTxtResolver" packages/zelavis/src/adapters/node.ts`; `ls zelavis-services/dns-cloudflare/src`; read `distribution/scripts/qualify-shards.mjs` in full.
- **Depends on**: parts 1, 7.
- **Check**: `pnpm --filter zelavis run build; echo "exit $?"` prints `exit 0`.

### 2. Write the qualification script and its local self-test

- **Files**: NEW `distribution/scripts/qualify-domains.mjs`; NEW `distribution/scripts/domains/fake-cloudflare.mjs`; root `package.json` (script).
- **Change**: section 2, sharing one leg implementation between live and self-test modes (the environment object differs). Imports from the built package (`packages/zelavis/dist/...`) for the DNS codec and from `zelavis-services/dns-cloudflare/dist` for the client.
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

## Execution report
