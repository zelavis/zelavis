import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { unitsWithOomScores } from "../dist/adapters/_systemd-oom-score.js";
import { PROJECT_OOM_SCORE_ADJ } from "../dist/adapters/_project-oom-score.js";

const template = name => readFile(new URL(`../../../distribution/runtime/${name}`, import.meta.url), "utf8");

test("a live update ranks the units it refreshed by their templates' OOM scores", async () => {
  const assets = await Promise.all(["zelavis.service", "zelavis-agent.service", "zelavis-host-agent.service", "zelavis-update.path"]
    .map(async name => ({ path: `/etc/systemd/system/${name}`, content: await template(name) })));
  assert.deepEqual(unitsWithOomScores(assets, "default"), ["zelavis.service", "zelavis-agent.service", "zelavis-host-agent.service"]);
  const named = await Promise.all(["zelavis@.service", "zelavis-agent@.service", "zelavis-host-agent@.service"]
    .map(async name => ({ path: `/etc/systemd/system/${name}`, content: await template(name) })));
  assert.deepEqual(unitsWithOomScores(named, "blue"), ["zelavis@blue.service", "zelavis-agent@blue.service", "zelavis-host-agent@blue.service"]);
});

test("a Project host raises itself to the score its Agent unit gives Projects", async () => {
  assert.ok((await template("zelavis-agent.service")).split("\n").includes(`OOMScoreAdjust=${PROJECT_OOM_SCORE_ADJ}`));
});
