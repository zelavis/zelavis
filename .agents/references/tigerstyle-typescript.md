# TigerStyle for Zelavis TypeScript and Effect v4

Adapted from [TigerBeetle's TigerStyle](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md).
Safety takes priority over performance, then developer experience. This is a
Zelavis adaptation, not a claim of literal TigerStyle compliance.

## Scope and authoring

Apply these principles throughout `packages/zelavis`, including bundled services
and UI. Database, ownership, host authority, and runtime handover require the
strongest integrity and recovery evidence.

Effect language-service suggestions do not override this policy: do not replace
an explicit justified failure handler with ignore/ignoreCause merely to satisfy
a stylistic diagnostic.

Effect v4 remains mandatory for new asynchronous orchestration; migrate touched legacy orchestration. Pure synchronous
calculations remain TypeScript. Do not replace Effect with handwritten Promise
coordination. Consult the pinned local Effect source and existing core skill.

Before implementing a stateful operation, identify its inputs, authority, state
transition, resource bounds, success condition, and recovery after interruption.
Keep pure calculations separate from acquiring resources and mutating state.

## Invariants and failures

- Validate external input and persisted records at boundaries. Type assertions
  and non-null assertions are not runtime validation. Use Effect Schema or a
  focused decoder with explicit length, shape, range, and version checks.
- Distinguish expected failures (invalid input, I/O errors, contention, stale
  ownership) from internal defects. Keep expected failures in typed Effect error
  channels. Do not convert them to success or silently discard them.
- A deliberately best-effort operation must explicitly handle the failure and
  explain why proceeding preserves safety; use an observable diagnostic where
  appropriate, without leaking secrets. Empty handlers and blanket Effect.ignore/ignoreCause
  are prohibited throughout the checked source. Use an explicit handler for an expected absence.
- An assertion inside Effect does not guarantee process termination. A violated
  integrity invariant must refuse affected writes or fence the affected owner;
  select the shutdown/recovery boundary deliberately. Never continue with guessed
  state or call process.exit from reusable library code.
- Check invariants on independent write/read paths where useful. Across yield
  points, re-prove mutable authority at use; atomic conditional commits and fencing
  remain necessary. A precondition or semaphore alone is not distributed authority.

## Resource bounds and performance

- Bound request/payload bytes, queue capacity, batch size, concurrency, retries,
  deadlines, and traversal depth. Define the limit and behavior at exhaustion.
  A finite input array alone is not a production memory or latency bound.
- Use pagination or bounded streaming for growing data. Do not truncate silently.
  Long-running loops need scoped lifetime, cancellation, and bounded work per turn.
- Use positive finite concurrency limits for Effect.all/forEach. Do not use
  concurrency: "unbounded". Inherited concurrency must have a proved finite bound.
- Acquire resources with scoped finalizers; cancellation and failed partial
  acquisition must release permits, files, sockets, and acquired processes.
- Explain asymptotic memory and I/O costs for new database operations. Batch
  expensive work; verify hot-path changes with representative measurements.
  Keep performance optimizations subordinate to consistency and ownership.
- Validate integer ranges, overflow/exhaustion, binary lengths, and rounding.
  JavaScript bitwise operations are 32-bit; number cannot represent every 64-bit
  integer. Use bigint or validated safe-integer domains where the contract needs it.

## Review and behavioral evidence

Use descriptive existing TypeScript naming, explicit units, cohesive functions,
and comments explaining non-obvious decisions. Function size is a review signal,
not a fixed line limit. No assertion quotas, blanket renaming, mandatory else
branches, dependency ban, or startup-only allocation requirement.

For database/authority changes, test valid and invalid inputs, limits and one past
limits, malformed/truncated persisted data, stale generations, interrupted writes,
retry/idempotency, and recovery without partial state becoming accepted success.
Select cases relevant to the changed contract, not ceremonial tests.
For new state-machine algorithms, use seeded model/property tests where useful:
compare observable behavior with a small independent reference model, record the
seed and operation trace, and test storage/cancellation faults at transition points.
These tests complement reasoning and review; passing fuzz tests is not a proof.

## Automated gate and its limits

`pnpm check:tigerstyle` is part of `pnpm verify` and therefore the existing runtime
CI. It parses production `.ts`/`.tsx` files under `packages/zelavis`, including
bundled services; generated output, dependency trees, declarations and test folders
are excluded. It rejects every occurrence of:

- Empty catch blocks and empty `.catch` callbacks, including commented empty bodies.
- Direct calls to imported Effect.ignore/ignoreCause (including renamed Effect imports).
- Literal concurrency: "unbounded" options on imported Effect.all/forEach.
- JSON.parse type assertions in database, core runtime/agent/Fabric, Platform,
  and adapter source files, including nested assertions through unknown. A cast to unknown alone is allowed
  because it does not claim the decoded data has a validated shape.

The initial 105 occurrences have been migrated. The gate now rejects every
finding; no baseline file, suppression directives, or exemption mechanism remain.

Decoded records use complete per-field runtime contracts. The shared JSON-value
validator is iterative and caps traversal at one million values; the shared parser
caps source length at 64 Mi code units. More restrictive protocol-specific byte,
file-count, and payload limits still apply before decoding. Type assertions after
validated decoding may express branded identities, not bypass shape validation.
Promise-only public protocols preserve their existing non-cancellable call semantics;
new native interruptible workflows must use scoped acquisition and finalizers.
Do not use a whole-workflow Promise wrapper as an Effect implementation.

The gate is a focused syntax check, not a type-aware proof: indirect aliases,
namespace imports, computed option values, re-exported helpers, and schema validity
still require review. It does not prove queue bounds, termination, distributed
safety, exhaustive error handling, or coverage. Do not present a passing check as
full TigerStyle compliance. Keep checks deterministic and add adversarial fixtures
when extending them. Run heavier seeded/fault tests locally on the Mac or a
non-production VPS; follow the GitHub zero-spend policy.
