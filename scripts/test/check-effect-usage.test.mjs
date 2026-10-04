import assert from "node:assert/strict";
import test from "node:test";
import { scanEffectUsage, violations, migratedFiles } from "../check-effect-usage.mjs";

test("Effect checking inspects syntax and ignores comments, strings and public Promise types", () => {
  assert.deepEqual(scanEffectUsage('// async function nope() {}\nconst label = "Promise.all([])";\nexport function boundary(): Promise<void> { return present(Effect.void); }'), []);
  assert.deepEqual(scanEffectUsage('const program = Effect.fn("test")(function*() { yield* Effect.sleep(1); });'), []);
});

test("new async functions, Promise construction and Promise coordination are rejected", () => {
  const findings = scanEffectUsage('export const work = async () => { await Promise.all([]); return new Promise(resolve => resolve(1)); };');
  assert.deepEqual(findings.map(f => f.kind), ['async-function', 'promise-coordination', 'promise-constructor']);
  assert.equal(violations(findings, []).length, 3);
});

test("legacy permissions bind actual function syntax and survive formatting and comments", () => {
  const baseline = scanEffectUsage('async function legacy() { await fetch("old"); }', 'legacy.ts');
  assert.equal(violations(scanEffectUsage('async function legacy ( ) { /* explanation */ await fetch( "old" ); }', 'legacy.ts'), baseline).length, 0);
  assert.equal(violations(scanEffectUsage('async function legacy() { await fetch("new"); }', 'legacy.ts'), baseline).length, 1);
  assert.equal(violations(scanEffectUsage('async function another() { await fetch("old"); }', 'legacy.ts'), baseline).length, 1);
  assert.equal(violations(scanEffectUsage('async function legacy() { await fetch("old"); }', 'new.ts'), baseline).length, 1);
});

test("a duplicate occurrence cannot reuse one baseline allowance", () => {
  const source = 'const operations = [async () => await leaf()';
  const baseline = scanEffectUsage(source + '];', 'legacy.ts');
  assert.equal(violations(scanEffectUsage(source + ', async () => await leaf()];', 'legacy.ts'), baseline).length, 1);
});

test("migrated lifecycle files reject all debt even if someone adds baseline entries", () => {
  for (const file of migratedFiles) {
    const findings = scanEffectUsage('async function regression() { await leaf(); }', file);
    assert.equal(violations(findings, findings).length, 1);
  }
});

test("an Effect Promise boundary preserves unchanged nested callback identity without permitting new orchestration", () => {
  const original = 'async function compose() { const handlers = [async () => await leaf("old")]; await load(); return handlers; }';
  const migrated = 'function compose() { return present(Effect.gen(function* () { const handlers = [async () => await leaf("old")]; yield* integration(() => load()); return handlers; })); }';
  const baseline = scanEffectUsage(original, "existing.ts");
  assert.equal(violations(scanEffectUsage(migrated, "existing.ts"), baseline).length, 0);
  assert.equal(violations(scanEffectUsage(migrated.replace('leaf("old")', 'leaf("new")'), "existing.ts"), baseline).length, 1);
  assert.throws(() => scanEffectUsage(migrated.replace('yield* integration(() => load())', 'await load()'), "existing.ts"), /reserved word/);
  assert.equal(violations(scanEffectUsage(migrated.replace('return handlers', 'return new Promise(resolve => resolve(handlers))'), "existing.ts"), baseline).length, 1);
  assert.equal(violations(scanEffectUsage(migrated.replace(']; yield*', ', async () => await leaf("old")]; yield*'), "existing.ts"), baseline).length, 1);
});
