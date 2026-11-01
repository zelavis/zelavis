import assert from "node:assert/strict";
import test from "node:test";
import { engineConvergence } from "../dist/core/runtime/engine-convergence.js";

test("a Project follows the Platform's engine only while both write the same data layout", () => {
  assert.deepEqual(engineConvergence({ from: 4, to: 4 }), { converge: true });
  const older = engineConvergence({ from: 2, to: 4 });
  assert.equal(older.converge, false);
  assert.match(older.reason, /format 2.*older.*format 4.*recipe is upgraded/);
  const newer = engineConvergence({ from: 5, to: 4 });
  assert.equal(newer.converge, false, "an engine never follows a Platform that would refuse the Project's data");
  assert.match(newer.reason, /newer/);
});

test("an engine whose data format is unknown or malformed is never converged", () => {
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(engineConvergence({ from: bad, to: 4 }).converge, false, `from ${bad}`);
    assert.equal(engineConvergence({ from: 4, to: bad }).converge, false, `to ${bad}`);
  }
});
