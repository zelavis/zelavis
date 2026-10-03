#!/usr/bin/env node
// Release tooling for the marketplace allow-list.
//
//   pnpm allowlist update [--skip-unpublished]  rebuild the list from zelavis-services + npm
//   pnpm allowlist publish [--expires-days <n>] write the list zelavis.com serves
//
// `update` rewrites `allowlist.snapshot.json`, the list every release ships.
// `publish` writes `website/public/allowlist.json`, a plain JSON copy with a
// fresh expiry that the next website deploy serves at
// https://zelavis.com/allowlist.json. There are no keys: https from zelavis.com
// is the trust anchor, as it is for the installer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
    found.push(manifest);
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

function readSnapshot() {
  return existsSync(snapshotFile) ? JSON.parse(readFileSync(snapshotFile, "utf8")) : undefined;
}

async function update() {
  const { parseAllowlist } = await library();
  const previous = readSnapshot();
  const services = new Map((previous?.services ?? []).map((service) => [service.name, service]));
  const skipped = [];
  for (const manifest of localServices()) {
    const existing = services.get(manifest.name);
    const versions = new Map((existing?.versions ?? []).map((entry) => [entry.version, entry]));
    if (!versions.has(manifest.version)) {
      const integrity = publishedIntegrity(manifest.name, manifest.version);
      if (!integrity) {
        if (!flags.get("skip-unpublished")) {
          fail(`${manifest.name}@${manifest.version} is not published to npm, so it has no digest to list. Publish it, or pass --skip-unpublished.`);
        }
        skipped.push(`${manifest.name}@${manifest.version}`);
        continue;
      }
      versions.set(manifest.version, { version: manifest.version, integrity });
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
  if (skipped.length) console.log(`Not listed (unpublished): ${skipped.join(", ")}`);
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

const commands = { update, publish };
if (!commands[command]) fail("Usage: pnpm allowlist <update|publish> [options]");
await commands[command]();
