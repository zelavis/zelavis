import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { unitOomScores } from "../dist/adapters/_systemd-oom-score.js";
import { PROJECT_OOM_SCORE_ADJ } from "../dist/adapters/_project-oom-score.js";

const template = name => readFile(new URL(`../../../distribution/runtime/${name}`, import.meta.url), "utf8");

test("a live update ranks the units it refreshed by their templates' OOM scores", async () => {
  const assets = await Promise.all(["zelavis.service", "zelavis-agent.service", "zelavis-host-agent.service", "zelavis-update.path"]
    .map(async name => ({ path: `/etc/systemd/system/${name}`, content: await template(name) })));
  assert.deepEqual(unitOomScores(assets, "default"), [
    { unit: "zelavis.service", score: -500 }, { unit: "zelavis-agent.service", score: 200 }, { unit: "zelavis-host-agent.service", score: -100 },
  ]);
  const named = await Promise.all(["zelavis@.service", "zelavis-agent@.service"].map(async name => ({ path: `/etc/systemd/system/${name}`, content: await template(name) })));
  assert.deepEqual(unitOomScores(named, "blue").map(entry => entry.unit), ["zelavis@blue.service", "zelavis-agent@blue.service"]);
  assert.throws(() => unitOomScores([{ path: "/x/a.service", content: "OOMScoreAdjust=-2000\n" }], "default"), /outside/);
});

test("a Project host raises itself to the score its Agent unit gives Projects", async () => {
  assert.equal(unitOomScores([{ path: "/x/zelavis-agent.service", content: await template("zelavis-agent.service") }], "default")[0].score, PROJECT_OOM_SCORE_ADJ);
});
