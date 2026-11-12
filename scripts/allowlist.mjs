#!/usr/bin/env node
// Release tooling for the marketplace allow-list.
//
//   pnpm allowlist update                   rebuild the list from zelavis-services (npm's digest, or the local pack's)
//   pnpm allowlist publish [--expires-days <n>] write the list zelavis.com serves
//   pnpm allowlist check                    refuse stale defaults before a Platform release
//
// `update` rewrites `allowlist.snapshot.json`, the list every release ships.
// `publish` writes `website/public/allowlist.json`, a plain JSON copy with a
// fresh expiry that the next website deploy serves at
// https://zelavis.com/allowlist.json. There are no keys: https from zelavis.com
// is the trust anchor, as it is for the installer.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertReleaseAllowlist, minimumPlatform } from "./release-allowlist.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = join(root, "packages/zelavis/services/zelavis-marketplace");
const snapshotFile = join(marketplace, "allowlist.snapshot.json");
const servicesRoot = join(root, "zelavis-services");
const publishedFile = join(root, "website/public/allowlist.json");
const DAY = 24 * 60 * 60 * 1000;

const [command, ...rest] = process.argv.slice(2);
const flags = new Map();
for (let index = 0; index < rest.length; index += 1) {
  if (!rest[index].startsWith("--")) fail(`Unexpected argument "${rest[index]}".`);
  const name = rest[index].slice(2);
  const next = rest[index + 1];
  if (next === undefined || next.startsWith("--")) flags.set(name, true);
  else { flags.set(name, next); index += 1; }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function library() {
  const entry = join(marketplace, "dist/allowlist/index.js");
  if (!existsSync(entry)) fail("Build the marketplace first: pnpm --filter @zelavis/marketplace build");
  return import(pathToFileURL(entry).href);
}

/** Every publishable service package in the checkout, including a service's own `plugins/*`. */
function localServices() {
  const found = [];
  const visit = (directory) => {
    const file = join(directory, "package.json");
    if (!existsSync(file)) return;
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (manifest.private || !manifest.zelavis?.kind) return;
    found.push({ ...manifest, directory });
  };
  for (const entry of readdirSync(servicesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const directory = join(servicesRoot, entry.name);
    visit(directory);
    const nested = join(directory, "plugins");
    if (!existsSync(nested)) continue;
    for (const child of readdirSync(nested, { withFileTypes: true })) {
      if (child.isDirectory()) visit(join(nested, child.name));
    }
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}

/** The digest npm serves for the published tarball, which is what an install verifies. */
function publishedIntegrity(name, version) {
  try {
    const output = execFileSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? JSON.parse(output) : undefined;
  } catch {
    return undefined;
  }
}

/** The `peerDependencies` npm serves for a published version, which is what an installation would run. */
function publishedPeers(name, version) {
  const output = execFileSync("npm", ["view", `${name}@${version}`, "peerDependencies", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return output ? JSON.parse(output) : {};
}

/**
 * The digest of the tarball this checkout packs, for a version npm does not have yet. Packing is
 * deterministic, and npm's digest is the digest of the uploaded tarball, so publishing that tarball makes
 * this the digest npm serves; the publisher refuses a tarball whose digest differs from the listed one.
 */
function packedIntegrity(manifest) {
  execFileSync("pnpm", ["--filter", manifest.name, "run", "--if-present", "build"], { cwd: root, stdio: "inherit" });
  const destination = mkdtempSync(join(tmpdir(), "zelavis-allowlist-pack-"));
  try {
    execFileSync("pnpm", ["pack", "--pack-destination", destination], { cwd: manifest.directory, stdio: ["ignore", "ignore", "inherit"] });
    const tarballs = readdirSync(destination).filter((file) => file.endsWith(".tgz"));
    if (tarballs.length !== 1) fail(`pnpm pack produced ${tarballs.length} tarballs for ${manifest.name}.`);
    return `sha512-${createHash("sha512").update(readFileSync(join(destination, tarballs[0]))).digest("base64")}`;
  } finally {
    rmSync(destination, { recursive: true, force: true });
  }
}

function readSnapshot() {
  return existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, "utf8")) : undefined;
}

async function update() {
  const { parseAllowlist } = await library();
  const previous = readSnapshot();
  const services = new Map((previous?.services ?? []).map((service) => [service.name, service]));
  for (const manifest of localServices()) {
    const existing = services.get(manifest.name);
    const versions = new Map((existing?.versions ?? []).map((entry) => [entry.version, entry]));
    if (!versions.has(manifest.version)) {
      const published = publishedIntegrity(manifest.name, manifest.version);
      const integrity = published ?? packedIntegrity(manifest);
      if (!published) console.log(`${manifest.name}@${manifest.version} is not on npm yet: listed with the digest of its local pack.`);
      versions.set(manifest.version, {
        version: manifest.version,
        integrity,
        platform: minimumPlatform(manifest.peerDependencies?.zelavis, `${manifest.name}@${manifest.version}`),
      });
    }
    // A version listed before minimums were recorded gets the one its published manifest declares.
    for (const [version, entry] of versions) {
      if (entry.platform) continue;
      versions.set(version, {
        ...entry,
        platform: minimumPlatform(publishedPeers(manifest.name, version).zelavis, `${manifest.name}@${version} on npm`),
      });
    }
    const marketplaceInfo = manifest.zelavis.marketplace ?? {};
    const ordered = [...versions.values()];
    services.set(manifest.name, {
      name: manifest.name,
      kind: manifest.zelavis.kind,
      maintainer: "zelavis",
      title: marketplaceInfo.title ?? manifest.name,
      ...(marketplaceInfo.summary ? { summary: marketplaceInfo.summary } : {}),
      ...(marketplaceInfo.categories ? { categories: marketplaceInfo.categories } : {}),
      ...(marketplaceInfo.tags ? { tags: marketplaceInfo.tags } : {}),
      ...(manifest.zelavis.project?.managed ? { managed: manifest.zelavis.project.managed } : {}),
      ...(manifest.zelavis.project?.runtimeKinds ? { runtimeKinds: manifest.zelavis.project.runtimeKinds } : {}),
      ...(manifest.zelavis.project?.hostPackages ? { hostPackages: manifest.zelavis.project.hostPackages } : {}),
      // Recipes that ship host code are ours, so this list vouches for it.
      ...(typeof manifest.zelavis.project?.runtime === "string" ? { projectRuntime: true } : {}),
      versions: ordered,
      latest: manifest.version,
    });
  }
  const now = new Date();
  const next = parseAllowlist({
    schemaVersion: 1,
    sequence: (previous?.sequence ?? 0) + 1,
    issuedAt: now.toISOString(),
    // The shipped list has to outlive a release that stays installed for a while.
    expiresAt: new Date(now.getTime() + 365 * DAY).toISOString(),
    services: [...services.values()].sort((left, right) => left.name.localeCompare(right.name)),
  });
  writeFileSync(snapshotFile, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Wrote sequence ${next.sequence} with ${next.services.length} service(s) to ${snapshotFile}.`);
}

async function publish() {
  const { parseAllowlist } = await library();
  const snapshot = readSnapshot();
  if (!snapshot) fail("There is no allow-list to publish. Run: pnpm allowlist update");
  // A published list is meant to be renewed, so it expires sooner than the shipped one.
  const days = Number(flags.get("expires-days") ?? 90);
  if (!Number.isFinite(days) || days <= 0) fail("--expires-days must be a positive number.");
  const issuedAt = new Date();
  const allowlist = parseAllowlist({ ...snapshot, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + days * DAY).toISOString() });
  mkdirSync(dirname(publishedFile), { recursive: true });
  writeFileSync(publishedFile, `${JSON.stringify(allowlist)}\n`);
  console.log(`Wrote sequence ${allowlist.sequence}; expires ${allowlist.expiresAt}. Deploy the website to publish ${publishedFile}.`);
}

async function check() {
  const { parseAllowlist } = await library();
  assertReleaseAllowlist(parseAllowlist(readSnapshot()), localServices());
  console.log("Shipped allow-list defaults match the qualified service versions.");
}

const commands = { update, publish, check };
if (!commands[command]) fail("Usage: pnpm allowlist <update|publish|check> [options]");
await commands[command]();
