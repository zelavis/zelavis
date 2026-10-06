import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTigerStyle, inventory } from "../check-tigerstyle.mjs";
const scan = source => scanTigerStyle(source);
const rules = source => scan(source).map(entry => entry.rule);

test("rejects empty catch blocks and callbacks even with comments", () => {
  assert.deepEqual(rules('try { work() } catch (error) { /* best effort */ } task.catch(() => {});'), ["silent-catch", "silent-catch"]);
  assert.deepEqual(rules('try { work() } catch (error) { report(error) } task.catch(error => report(error));'), []);
});
test("detects Effect methods through renamed imports, not unrelated objects", () => {
  assert.deepEqual(rules('import { Effect as E } from "effect"; E.ignore(task); E.forEach(items, run, { concurrency: "unbounded" });'), ["effect-ignore", "unbounded-concurrency"]);
  assert.deepEqual(rules('import { Effect } from "effect"; Effect.ignoreCause(task);'), ["effect-ignore"]);
  assert.deepEqual(rules('const Effect = custom; Effect.ignore(task);'), []);
});
test("permits bounded and sequential Effect orchestration", () => {
  assert.deepEqual(rules('import { Effect } from "effect"; Effect.all(tasks, { concurrency: 4 }); Effect.forEach(items, run); Effect.gen(function* () { yield* task; });'), []);
});
test("detects computed member syntax and quoted concurrency property", () => {
  assert.deepEqual(rules('import { Effect } from "effect"; Effect["all"](tasks, { "concurrency": "unbounded" });'), ["unbounded-concurrency"]);
});
test("JSON assertions are gated in sensitive directories, including double casts", () => {
  assert.deepEqual(rules('const record = JSON.parse(bytes) as Record;'), ["unchecked-json-cast"]);
  assert.equal(scan('const record = JSON.parse(bytes) as unknown as Record;').length, 1);
  assert.deepEqual(rules('const record = JSON.parse(bytes) as unknown;'), []);
  assert.equal(scanTigerStyle('const record = JSON.parse(bytes) as Record;', 'packages/zelavis/services/zelavis-ui/src/page.tsx').length, 0);
  assert.deepEqual(rules('const record = decodeRecord(JSON.parse(bytes));'), []);
});
test("every production occurrence is reported, including copies and comments", () => {
  const source = 'try { work() } catch (error) {}';
  assert.equal(scan(source + '; ' + source).length, 2);
  assert.equal(scan('function other() { try { work() } catch (error) { /* rationale alone is not handling */ } }').length, 1);
});
test("parses TSX and ignores patterns inside strings", () => {
  assert.deepEqual(rules('const view = <div>{"Effect.ignore(task)"}</div>;'), []);
});

test("inventory includes service TSX but excludes output, tests and dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-tigerstyle-"));
  try {
    for (const folder of ["services/ui/app", "dist", "node_modules", "test"]) {
      await mkdir(join(directory, folder), { recursive: true });
      await writeFile(join(directory, folder, "example.tsx"), "try { work() } catch (error) {}");
    }
    await writeFile(join(directory, "example.d.ts"), "invalid declaration content");
    const findings = await inventory(directory);
    assert.equal(findings.length, 1);
    assert.ok(findings[0].file.endsWith("services/ui/app/example.tsx"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
