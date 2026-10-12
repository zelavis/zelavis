#!/usr/bin/env node
/**
 * Points the recipes' PHP at the archives `build.sh` produced.
 *
 *   node pin.mjs --builds out/builds.jsonl --base https://mirror.zelavis.com/php
 *   node pin.mjs --builds a.jsonl --builds b.jsonl --base https://mirror.zelavis.com/php --dry-run
 *
 * For every build record it finds, in each recipe's `zelavis.project.install.runtimes`, the entry of the same
 * command (`php` for the CLI archive, `php-fpm` for the FPM one) and the same PHP series (8.4 matches 8.4.x), and
 * sets that entry's version and the build's platform download: the address below `--base`, the SHA-256, a size
 * bound with a little room, and the executable. Platforms a build does not cover are left as they are, so
 * pinning can proceed one platform at a time. Nothing is fetched; the digest is whatever the build recorded.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLATFORMS = new Set(["linux-x86_64", "linux-aarch64", "macos-x86_64", "macos-aarch64"]);
const COMMANDS = new Map([["cli", "php"], ["fpm", "php-fpm"]]);

const series = (version) => version.split(".").slice(0, 2).join(".");

/** The build records in the given `builds.jsonl` texts, checked. */
export function readBuilds(texts) {
  const records = [];
  for (const text of texts) {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      const record = JSON.parse(line);
      if (!/^\d+\.\d+\.\d+$/.test(record.php)) throw new Error(`"${record.php}" is not an exact PHP version.`);
      if (!COMMANDS.has(record.sapi)) throw new Error(`Unknown SAPI "${record.sapi}".`);
      if (!PLATFORMS.has(record.platform)) throw new Error(`Unknown platform "${record.platform}".`);
      if (!/^[0-9a-f]{64}$/.test(record.sha256)) throw new Error(`"${record.file}" has no SHA-256.`);
      if (!Number.isInteger(record.bytes) || record.bytes < 1) throw new Error(`"${record.file}" has no size.`);
      if (record.executable !== COMMANDS.get(record.sapi)) throw new Error(`"${record.file}" holds "${record.executable}", not the ${record.sapi} program.`);
      if (!/^[A-Za-z0-9._-]+$/.test(record.file)) throw new Error(`"${record.file}" is not a plain file name.`);
      records.push(record);
    }
  }
  return records;
}

/**
 * The manifest with the builds pinned, and what changed. `manifest` is a recipe's parsed package.json; the
 * result is a copy.
 */
export function pinManifest(manifest, builds, base) {
  const next = structuredClone(manifest);
  const runtimes = next.zelavis?.project?.install?.runtimes;
  const changes = [];
  if (!Array.isArray(runtimes)) return { manifest: next, changes };
  for (const build of builds) {
    const command = COMMANDS.get(build.sapi);
    const runtime = runtimes.find((entry) => entry.command === command && series(entry.version) === series(build.php));
    if (!runtime) continue;
    const download = {
      archive: `${base.replace(/\/+$/, "")}/${build.php}/${build.file}`,
      sha256: build.sha256,
      // Room for a rebuild that comes out a little larger, never an open door.
      maxBytes: Math.ceil((build.bytes * 1.1) / 1024) * 1024,
      executable: build.executable,
    };
    const before = runtime.downloads[build.platform];
    if (runtime.version === build.php && before && JSON.stringify(before) === JSON.stringify(download)) continue;
    changes.push(`${command} ${runtime.version} -> ${build.php} on ${build.platform}`);
    runtime.version = build.php;
    runtime.downloads[build.platform] = download;
  }
  return { manifest: next, changes };
}

/** Every recipe package.json below `directory` that has runtimes (`zelavis-services/*`). */
export function recipeManifests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name, "package.json"))
    .filter((file) => { try { return Array.isArray(JSON.parse(readFileSync(file, "utf8")).zelavis?.project?.install?.runtimes); } catch { return false; } });
}

function main(argv) {
  const builds = [];
  let base;
  let recipes = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "zelavis-services");
  let dry = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") dry = true;
    else if (arg === "--builds") builds.push(readFileSync(resolve(argv[++index] ?? ""), "utf8"));
    else if (arg === "--base") base = argv[++index];
    else if (arg === "--recipes") recipes = resolve(argv[++index] ?? "");
    else throw new Error(`Unknown option ${arg}.`);
  }
  if (builds.length === 0 || !base) throw new Error("Usage: pin.mjs --builds FILE [--builds FILE] --base https://host/php [--recipes DIR] [--dry-run]");
  if (!/^https:\/\/[^/\s]+(\/[^\s]*)?$/.test(base)) throw new Error("--base must be an https address.");
  const records = readBuilds(builds);
  let total = 0;
  for (const file of recipeManifests(recipes)) {
    const { manifest, changes } = pinManifest(JSON.parse(readFileSync(file, "utf8")), records, base);
    if (changes.length === 0) continue;
    total += changes.length;
    console.log(`${file}\n  ${changes.join("\n  ")}`);
    if (!dry) writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(total === 0 ? "Nothing to change." : `${dry ? "Would change" : "Changed"} ${total} runtime download(s).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(`pin.mjs: ${error.message}`); process.exit(1); }
}
