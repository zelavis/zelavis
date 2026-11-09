// Disposable release tests stand in for npm only for the exact service archives
// that this release will publish. The Platform still verifies both digests and
// installs through the ordinary allow-list and package acquisition path.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

const registry = "https://registry.npmjs.org";
const digest = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
const packagePath = (name) => name.split("/").map(encodeURIComponent).join("/");
const metadataUrl = (name, version) => `${registry}/${packagePath(name)}/${encodeURIComponent(version)}`;
const tarballUrl = (name, version) => `${registry}/${packagePath(name)}/-/${name.split("/").at(-1)}-${version}.tgz`;

async function stage(root, destination) {
  const snapshot = JSON.parse(readFileSync(join(root, "packages/zelavis/services/zelavis-marketplace/allowlist.snapshot.json"), "utf8"));
  const workspaces = JSON.parse(execFileSync("pnpm", ["list", "-r", "--depth", "-1", "--json"], { cwd: root, encoding: "utf8" }));
  const servicesRoot = realpathSync(join(root, "zelavis-services")) + sep;
  const entries = [];
  for (const { name, version, path } of workspaces) {
    if (!realpathSync(path).startsWith(servicesRoot)) continue;
    const listed = snapshot.services.find((service) => service.name === name)?.versions.find((item) => item.version === version);
    if (!listed) continue;
    const published = await fetch(metadataUrl(name, version), { redirect: "error", signal: AbortSignal.timeout(15_000) });
    await published.body?.cancel();
    if (published.ok) continue;
    if (published.status !== 404) throw new Error(`Could not check npm for ${name}@${version}: ${published.status}`);

    mkdirSync(destination, { recursive: true, mode: 0o755 });
    const packing = join(destination, "packing");
    mkdirSync(packing, { recursive: true });
    execFileSync("pnpm", ["pack", "--pack-destination", packing], { cwd: path, stdio: ["ignore", "ignore", "inherit"] });
    const files = readdirSync(packing);
    if (files.length !== 1 || !files[0].endsWith(".tgz")) throw new Error(`Expected one tarball for ${name}@${version}.`);
    const archive = join(packing, files[0]);
    if (digest(readFileSync(archive)) !== listed.integrity) throw new Error(`Local pack differs from the allow-list for ${name}@${version}.`);
    const file = `${entries.length}.tgz`;
    renameSync(archive, join(destination, file));
    // The next pack must also produce exactly one new file.
    entries.push({ name, version, file, integrity: listed.integrity });
    console.log(`Qualification staged ${name}@${version} with its listed digest.`);
  }
  if (entries.length) writeFileSync(join(destination, "index.json"), JSON.stringify(entries));
}

function useFixture(directory) {
  if (process.env.ZELAVIS_PROVISIONING_DISPOSABLE !== "1" || !existsSync("/.dockerenv")) {
    throw new Error("The candidate registry may only run in a disposable qualification container.");
  }
  const routes = new Map();
  const entries = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
  for (const { name, version, file, integrity } of entries) {
    if (basename(file) !== file || !/^\d+\.tgz$/.test(file)) throw new Error("Invalid qualification archive path.");
    const archive = join(directory, file);
    const tarball = tarballUrl(name, version);
    routes.set(metadataUrl(name, version), () => Response.json({ version, dist: { tarball, integrity } }));
    routes.set(tarball, () => new Response(readFileSync(archive), { headers: { "content-type": "application/octet-stream" } }));
  }
  const fetchFromNetwork = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const route = routes.get(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!route || (options?.method ?? (input instanceof Request ? input.method : "GET")) !== "GET") {
      return fetchFromNetwork(input, options);
    }
    (options?.signal ?? (input instanceof Request ? input.signal : undefined))?.throwIfAborted();
    return route();
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await stage(process.argv[2], process.argv[3]);
} else if (process.env.ZELAVIS_QUALIFICATION_REGISTRY) {
  useFixture(process.env.ZELAVIS_QUALIFICATION_REGISTRY);
}
