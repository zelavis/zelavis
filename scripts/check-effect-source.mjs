#!/usr/bin/env node
// Fails when the vendored Effect source (repos/effect) is not the release the
// repository depends on. The vendored copy is reference material for people and
// coding agents; one that lags the pinned `effect` version teaches an API that is
// no longer the one in use.
//
// Fix it with: scripts/update-effect-source.sh effect@<pinned version>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const read = (path) => readFileSync(join(root, path), "utf8");

const manifests = execFileSync("git", ["ls-files", "--", "package.json", "**/package.json", ":!repos/**"], {
  cwd: root,
  encoding: "utf8",
}).split("\n").filter(Boolean);

const pins = new Map();
for (const file of manifests) {
  const manifest = JSON.parse(read(file));
  for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
    const range = manifest[field]?.effect;
    if (range !== undefined) pins.set(file, range);
  }
}

const problems = [];
if (pins.size === 0) problems.push("No package depends on `effect`; remove repos/effect and this check, or restore the dependency.");

const versions = new Set(pins.values());
if (versions.size > 1) {
  problems.push(
    `Packages pin different effect versions: ${[...pins].map(([file, range]) => `${file} ${range}`).join(", ")}. They must match.`,
  );
}

const [pinned] = versions;
if (pinned !== undefined) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pinned)) {
    problems.push(`effect must be pinned to an exact version, found "${pinned}".`);
  } else {
    const [tag] = read("repos/effect/VENDORED_FROM").split("\n");
    const vendored = JSON.parse(read("repos/effect/packages/effect/package.json")).version;
    if (tag !== `effect@${pinned}`) {
      problems.push(`repos/effect/VENDORED_FROM says "${tag}" but the pinned effect is ${pinned}.`);
    }
    if (vendored !== pinned) {
      problems.push(`repos/effect/packages/effect is ${vendored} but the pinned effect is ${pinned}.`);
    }
  }
}

if (problems.length > 0) {
  console.error(`The vendored Effect source is out of step with the pinned version:\n- ${problems.join("\n- ")}`);
  console.error("\nFix: scripts/update-effect-source.sh effect@" + (pinned ?? "<version>"));
  process.exit(1);
}
console.log(`Vendored Effect source matches the pinned effect ${pinned}.`);
