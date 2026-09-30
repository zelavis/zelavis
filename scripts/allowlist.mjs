#!/usr/bin/env node
// Release tooling for the marketplace allow-list.
//
//   pnpm allowlist keygen [--out <file>]        make the release signing key
//   pnpm allowlist update [--skip-unpublished]  rebuild the list from zelavis-services + npm
//   pnpm allowlist sign [--key <file>] [--out <file>] [--expires-days <n>]
//
// `update` rewrites `allowlist.snapshot.json` (the unsigned list every release
// ships, and the source `sign` signs). `sign` writes the envelope that is
// uploaded to every source. The private key never lives in the repository.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketplace = join(root, "packages/zelavis/services/zelavis-marketplace");
const snapshotFile = join(marketplace, "allowlist.snapshot.json");
const servicesRoot = join(root, "zelavis-services");
const defaultKeyFile = join(homedir(), ".zelavis-release", "allowlist-signing-key.json");
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

async function keygen() {
  const file = resolve(String(flags.get("out") ?? defaultKeyFile));
  if (existsSync(file)) fail(`${file} already exists; a signing key is never overwritten.`);
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
  const keyId = `zelavis-${new Date().getUTCFullYear()}-${publicKey.slice(-8).replace(/[^A-Za-z0-9]/g, "x").toLowerCase()}`;
  const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ keyId, publicKey, privateKey }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote the private key to ${file} (mode 0600). Back it up somewhere safe and offline: losing it means shipping a new key.`);
  console.log("Put this in OFFICIAL_ALLOWLIST_KEYS (packages/zelavis/src/adapters/_marketplace-allowlist.ts):");
  console.log(JSON.stringify({ keyId, publicKey }, null, 2));
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

async function sign() {
  const { signAllowlist } = await library();
  const keyFile = resolve(String(flags.get("key") ?? process.env.ZELAVIS_ALLOWLIST_KEY_FILE ?? defaultKeyFile));
  if (!existsSync(keyFile)) fail(`No signing key at ${keyFile}. Run: pnpm allowlist keygen`);
  const key = JSON.parse(readFileSync(keyFile, "utf8"));
  const snapshot = readSnapshot();
  if (!snapshot) fail("There is no allow-list to sign. Run: pnpm allowlist update");
  // A published list is meant to be renewed, so it expires sooner than the shipped one.
  const days = Number(flags.get("expires-days") ?? 90);
  if (!Number.isFinite(days) || days <= 0) fail("--expires-days must be a positive number.");
  const issuedAt = new Date();
  const allowlist = { ...snapshot, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + days * DAY).toISOString() };
  const privateKey = await crypto.subtle.importKey("pkcs8", Buffer.from(key.privateKey, "base64"), "Ed25519", false, ["sign"]);
  const envelope = await signAllowlist({ privateKey, keyId: key.keyId, allowlist });
  const out = resolve(String(flags.get("out") ?? "allowlist.json"));
  writeFileSync(out, `${JSON.stringify(envelope)}\n`);
  console.log(`Signed sequence ${allowlist.sequence} with ${key.keyId}; expires ${allowlist.expiresAt}. Upload ${out} to every source.`);
}

const commands = { keygen, update, sign };
if (!commands[command]) fail("Usage: pnpm allowlist <keygen|update|sign> [options]");
await commands[command]();
