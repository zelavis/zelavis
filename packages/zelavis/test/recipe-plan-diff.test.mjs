// What turning one plan into another means for running processes, decided purely.
import assert from "node:assert/strict";
import test from "node:test";

import { Step, changesNothing, dependencyLevels, planSteps } from "zelavis/recipe";

const fp = (launch, config = "c") => ({ launch, config });
const live = (name, launch, over = {}) => ({ name, fingerprint: fp(launch, over.config), dependsOn: over.dependsOn ?? [], alive: over.alive ?? true });
const want = (name, launch, over = {}) => ({ name, fingerprint: fp(launch, over.config), dependsOn: over.dependsOn ?? [], update: over.update ?? { strategy: "restart" } });
const tags = (groups) => groups.map((group) => group.map((step) => `${step._tag}:${step.name}`));

test("a plan identical to what runs changes nothing at all", () => {
  const steps = planSteps([live("db", "d"), live("web", "w", { dependsOn: ["db"] })], [want("db", "d"), want("web", "w", { dependsOn: ["db"] })]);
  assert.deepEqual(tags(steps), [["Keep:db"], ["Keep:web"]]);
  assert.equal(changesNothing(steps), true);
});

test("each kind of difference has exactly one meaning", () => {
  const running = [live("kept", "k"), live("reloadable", "r"), live("restarted", "s"), live("moved", "m"), live("dead", "x", { alive: false }), live("gone", "g")];
  const wanted = [
    want("kept", "k"),
    want("reloadable", "r", { config: "new", update: { strategy: "reload", signal: "SIGHUP" } }),
    want("restarted", "s", { config: "new" }),
    want("moved", "m2"),
    want("dead", "x"),
    want("fresh", "f"),
  ];
  const byName = Object.fromEntries(planSteps(running, wanted).flat().map((step) => [step.name, step]));
  assert.deepEqual(byName.kept, Step.Keep({ name: "kept" }));
  assert.deepEqual(byName.reloadable, Step.Reload({ name: "reloadable", signal: "SIGHUP" }));
  assert.deepEqual(byName.restarted, Step.Replace({ name: "restarted", reason: "config" }));
  assert.deepEqual(byName.moved, Step.Replace({ name: "moved", reason: "launch" }));
  assert.deepEqual(byName.dead, Step.Replace({ name: "dead", reason: "exited" }));
  assert.deepEqual(byName.fresh, Step.Add({ name: "fresh" }));
  assert.deepEqual(byName.gone, Step.Remove({ name: "gone" }));
});

test("a changed launch is a replacement even when the process would reload, because the signal cannot change how it was started", () => {
  const steps = planSteps([live("web", "old", { config: "a" })], [want("web", "new", { config: "b", update: { strategy: "reload", signal: "SIGUSR2" } })]);
  assert.deepEqual(steps[0][0], Step.Replace({ name: "web", reason: "launch" }));
});

test("dependencies come before what depends on them, independent processes share a group, removals go last and reversed", () => {
  const wanted = [want("web", "w", { dependsOn: ["app"] }), want("app", "a", { dependsOn: ["db"] }), want("db", "d"), want("cache", "c")];
  assert.deepEqual(tags(planSteps([], wanted)), [["Add:cache", "Add:db"], ["Add:app"], ["Add:web"]]);

  const running = [live("web", "w", { dependsOn: ["app"] }), live("app", "a", { dependsOn: ["db"] }), live("db", "d")];
  assert.deepEqual(tags(planSteps(running, [])), [["Remove:web"], ["Remove:app"], ["Remove:db"]], "dependents stop before what they use");
});

test("replacing a process does not replace what depends on it", () => {
  const steps = planSteps(
    [live("db", "d1"), live("web", "w", { dependsOn: ["db"] })],
    [want("db", "d2"), want("web", "w", { dependsOn: ["db"] })],
  );
  assert.deepEqual(tags(steps), [["Replace:db"], ["Keep:web"]]);
});

test("a cycle is refused rather than looped on", () => {
  assert.throws(() => dependencyLevels([{ name: "a", dependsOn: ["b"] }, { name: "b", dependsOn: ["a"] }]), /cycle/);
});

// A small seeded generator, so a failure names the seed that reproduces it.
const generator = (seed) => { let state = seed >>> 0; return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; }; };

test("whatever the plans, applying the steps and planning again leaves nothing to do (seeded)", () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = generator(seed);
    const names = ["a", "b", "c", "d", "e", "f"].filter(() => random() < 0.7);
    const pick = (index) => names.slice(0, index).filter(() => random() < 0.5);
    const make = () => names.filter(() => random() < 0.8).map((name, index) => ({ name, dependsOn: pick(index).filter((dependency) => true), launch: `l${Math.floor(random() * 3)}`, config: `c${Math.floor(random() * 2)}`, reload: random() < 0.5 }));
    const closed = (processes) => processes.map((process) => ({ ...process, dependsOn: process.dependsOn.filter((dependency) => processes.some((other) => other.name === dependency)) }));
    const before = closed(make());
    const after = closed(make());
    const running = before.map((process) => live(process.name, process.launch, { config: process.config, dependsOn: process.dependsOn }));
    const wanted = after.map((process) => want(process.name, process.launch, { config: process.config, dependsOn: process.dependsOn, update: process.reload ? { strategy: "reload", signal: "SIGHUP" } : { strategy: "restart" } }));
    let steps;
    try { steps = planSteps(running, wanted); } catch (error) { assert.match(error.message, /cycle/, `seed ${seed}`); continue; }

    // Every wanted process is touched exactly once; every leaving one is removed once; nothing else appears.
    const flat = steps.flat();
    assert.deepEqual(flat.filter((step) => step._tag !== "Remove").map((step) => step.name).sort(), wanted.map((process) => process.name).sort(), `seed ${seed}: each wanted process appears once`);
    assert.deepEqual(flat.filter((step) => step._tag === "Remove").map((step) => step.name).sort(), before.filter((process) => !after.some((other) => other.name === process.name)).map((process) => process.name).sort(), `seed ${seed}: exactly the leaving processes are removed`);

    // Order: a step never comes before a step it depends on, and removals come after everything else.
    const position = new Map(steps.flatMap((group, index) => group.map((step) => [step.name, index])));
    for (const process of after) for (const dependency of process.dependsOn) {
      assert.ok(position.get(dependency) < position.get(process.name), `seed ${seed}: ${dependency} before ${process.name}`);
    }
    const lastForward = Math.max(-1, ...flat.map((step, i) => step._tag === "Remove" ? -1 : position.get(step.name)));
    for (const step of flat) if (step._tag === "Remove") assert.ok(position.get(step.name) > lastForward, `seed ${seed}: removals last`);

    // Applying the steps yields exactly the wanted fingerprints, and planning again changes nothing.
    const applied = wanted.map((process) => live(process.name, process.fingerprint.launch, { config: process.fingerprint.config, dependsOn: process.dependsOn }));
    assert.equal(changesNothing(planSteps(applied, wanted)), true, `seed ${seed}: converged`);
  }
});
