import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { createNodeRuntimeJournal } from "../dist/adapters/_node-runtime-journal.js";
import { createNodeRuntimeGateway } from "../dist/adapters/_node-runtime-gateway.js";
import { freezeNodeProjectRelease, verifyNodeProjectRelease } from "../dist/adapters/_node-project-release.js";
import { createNodeProcessProjectRuntime } from "../dist/adapters/_node-project-runtime.js";
import { IntegrationFailure } from "../dist/core/runtime/effect-boundary.js";
import { createRuntimeAdmission } from "../dist/core/runtime/admission.js";
import { createRuntimeHandover } from "../dist/core/runtime/handover.js";
import { createGatewayAuthoritySecret, createGatewayAuthorityNonce, signGatewayAuthority, verifyGatewayAuthority, ZELAVIS_GATEWAY_AUTHORITY_HEADER } from "../dist/platform/gateway-authority.js";

const old = { version: "1.0.0", digest: `sha256:${"a".repeat(64)}` };
const next = { version: "2.0.0", digest: `sha256:${"b".repeat(64)}` };
const transition = (phase, generation = 2) => ({ phase, generation, previous: old, target: next });
const scoped = fn => Effect.runPromise(Effect.scoped(Effect.gen(fn)));

test("a recovered supervisor fences prior owners and advances beyond an unfinished handover", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-runtime-journal-")), file = join(directory, "runtime.json");
  try {
    await scoped(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      assert.deepEqual(yield* journal.recover(old, Effect.void), { release: old, generation: 1 });
      yield* journal.checkpoint(transition("prepared"));
      yield* journal.checkpoint(transition("releasing"));
      yield* journal.checkpoint(transition("activating"));
    });
    const bytes = await readFile(file, "utf8");
    await assert.rejects(scoped(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      yield* journal.recover(old, Effect.fail(new IntegrationFailure(new Error("prior engine could not be fenced"))));
    }), /could not be fenced/);
    assert.equal(await readFile(file, "utf8"), bytes);
    await scoped(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      let fenced = false;
      const ownership = yield* journal.recover(next, Effect.sync(() => { fenced = true; }));
      assert.equal(fenced, true);
      assert.deepEqual(ownership, { release: old, generation: 3 });
      assert.equal(journal.snapshot().transition, undefined);
      yield* Effect.asVoid(Effect.result(journal.checkpoint(transition("prepared", 2))).pipe(Effect.tap(result => Effect.sync(() => assert.equal(result._tag, "Failure")))));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("only a handover can commit a release, and concurrent journal owners are refused by the kernel", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-runtime-journal-")), file = join(directory, "runtime.json");
  try {
    await scoped(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      yield* journal.recover(old, Effect.void);
      assert.equal((yield* Effect.result(journal.commit(next, 2)))._tag, "Failure");
      assert.equal((yield* Effect.result(Effect.scoped(createNodeRuntimeJournal(file))))._tag, "Failure");
      yield* journal.checkpoint(transition("prepared"));
      yield* journal.checkpoint(transition("releasing"));
      yield* journal.checkpoint(transition("activating"));
      yield* journal.checkpoint(transition("committing"));
      yield* journal.commit(next, 2);
      yield* journal.checkpoint(transition("ready"));
    });
    await scoped(function* () {
      const journal = yield* createNodeRuntimeJournal(file);
      assert.deepEqual(yield* journal.recover(old, Effect.void), { release: next, generation: 3 });
    });
    await writeFile(file, JSON.stringify({ format: "zelavis-runtime/1", generation: "broken", selected: next }));
    await assert.rejects(scoped(function* () { const journal = yield* createNodeRuntimeJournal(file); yield* journal.recover(old, Effect.void); }), /Invalid runtime journal/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const fault of ["drain", "activate", "ready"]) test(`the shared controller and persisted journal can retry after ${fault} failure without reusing a generation`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-runtime-retry-"));
  try {
    await scoped(function* () {
      const journal = yield* createNodeRuntimeJournal(join(directory, "runtime.json"));
      const initial = yield* journal.recover(old, Effect.void);
      const admission = createRuntimeAdmission({ queueLimit: 2 });
      let failing = true;
      const controller = createRuntimeHandover({ admission, drainTimeoutMs: 1, initial: { ...initial, owner: old.version },
        host: {
          prepare: release => Effect.succeed(release.version), deactivate: () => Effect.void, discard: () => Effect.void,
          activate: owner => fault === "activate" && failing ? Effect.fail(new IntegrationFailure(new Error("activation failed"))) : Effect.succeed(owner),
          restore: release => Effect.succeed(release.version), probe: () => Effect.void,
          checkpoint: value => journal.checkpoint(value).pipe(Effect.andThen(Effect.suspend(() => value.phase === "ready" && fault === "ready" && failing ? Effect.fail(new IntegrationFailure(new Error("checkpoint acknowledged failure"))) : Effect.void))),
          commit: (release, _, generation) => journal.commit(release, generation),
        },
      });
      const releaseRequest = fault === "drain" ? yield* admission.enter : undefined;
      assert.equal((yield* Effect.result(controller.replace(next)))._tag, "Failure");
      releaseRequest?.(); failing = false;
      assert.equal(controller.snapshot().requiresRecovery, false);
      const success = yield* controller.replace(next);
      assert.equal(success.generation, fault === "drain" ? 3 : 4);
      assert.deepEqual(journal.snapshot().selected, next);
      assert.equal(journal.snapshot().generation, success.generation);
      assert.equal(journal.snapshot().transition.phase, "ready");
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Gateway replay protection survives engine changes and queued authority is renewed for the selected worker", async () => {
  const parentSecret = createGatewayAuthoritySecret();
  let workerSecret = createGatewayAuthoritySecret();
  const gateway = createNodeRuntimeGateway({ projectId: "one", parentSecret: () => parentSecret, workerSecret: () => workerSecret });
  const now = Date.now();
  const token = await signGatewayAuthority(parentSecret, { projectId: "one", scopeId: "platform", generation: 7, runtimeNodeId: "local",
    subject: "member", subjectType: "user", tenantId: "tenant", permissions: ["db.read"], expiresAt: now + 30_000, nonce: createGatewayAuthorityNonce() });
  const queued = await Effect.runPromise(gateway({ host: "app.example", [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: token }));
  const previousWorker = workerSecret;
  workerSecret = createGatewayAuthoritySecret();
  const realNow = Date.now;
  try {
    Date.now = () => now + 31_000;
    const forwarded = await Effect.runPromise(queued());
    const privateToken = forwarded[ZELAVIS_GATEWAY_AUTHORITY_HEADER];
    assert.equal(forwarded.host, "app.example");
    assert.equal(await verifyGatewayAuthority(previousWorker, privateToken, { audienceProjectId: "one" }), undefined);
    const claims = await verifyGatewayAuthority(workerSecret, privateToken, { audienceProjectId: "one" });
    assert.deepEqual(claims.permissions, ["db.read"]);
    assert.equal(claims.generation, 7);
    assert.equal(claims.subject, "member");
    assert.equal(claims.expiresAt, now + 61_000);
  } finally { Date.now = realNow; }
  const replayed = await Effect.runPromise((await Effect.runPromise(gateway({ [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: token })))());
  assert.equal(replayed[ZELAVIS_GATEWAY_AUTHORITY_HEADER], undefined);
  const forged = await Effect.runPromise((await Effect.runPromise(gateway({ [ZELAVIS_GATEWAY_AUTHORITY_HEADER]: "forged" })))());
  assert.equal(forged[ZELAVIS_GATEWAY_AUTHORITY_HEADER], undefined);
});

test("immutable Project snapshots survive canonical recipe replacement and refuse modified bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-project-snapshot-"));
  const driver = createNodeProcessProjectRuntime({ directory: root });
  try {
    const manifest = JSON.parse(await readFile(new URL("../services/zelavis-app/package.json", import.meta.url), "utf8"));
    const recipe = { name: manifest.name, version: manifest.version, specifier: manifest.name, runtimeKinds: ["native"] };
    const project = { id: "one", name: "One", kind: "zelavis", runtimeKind: "native", recipe };
    await driver.prepare(project, recipe);
    const directory = join(root, "one");
    const first = await Effect.runPromise(freezeNodeProjectRelease(directory));
    assert.deepEqual(await Effect.runPromise(freezeNodeProjectRelease(directory)), first);
    const source = join(root, "staged");
    await cp(directory, source, { recursive: true });
    const descriptor = JSON.parse(await readFile(join(source, "project.json"), "utf8"));
    descriptor.name = "New label";
    await writeFile(join(source, "project.json"), JSON.stringify(descriptor));
    const second = await Effect.runPromise(freezeNodeProjectRelease(directory, source));
    assert.notEqual(second.digest, first.digest);
    await writeFile(join(directory, ".zelavis", "recipe", "package", "package.json"), "broken canonical recipe");
    const before = await Effect.runPromise(verifyNodeProjectRelease(directory, "one", first));
    assert.equal(before.record.name, "One");
    assert.equal((await Effect.runPromise(verifyNodeProjectRelease(directory, "one", second))).record.name, "New label");
    await assert.rejects(Effect.runPromise(verifyNodeProjectRelease(directory, "other", first)), /mismatched identity/);
    await writeFile(join(before.snapshot, "project.json"), "modified");
    await assert.rejects(Effect.runPromise(verifyNodeProjectRelease(directory, "one", first)), /locked digest/);
  } finally { await driver.close(); await rm(root, { recursive: true, force: true }); }
});
