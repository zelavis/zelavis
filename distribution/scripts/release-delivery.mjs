import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exactVersion } from "./published-package.mjs";
import { fileChecksum, writeChecksums } from "./checksums.mjs";

export const releaseTargets = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];

function separateDirectories(input, output) {
  const inside = (parent, child) => {
    const distance = relative(resolve(parent), resolve(child));
    return !distance || distance !== ".." && !distance.startsWith(`..${sep}`);
  };
  if (inside(input, output) || inside(output, input)) {
    throw new Error("Delivery output must be separate from its input.");
  }
}

/** Verify every native job before emitting one complete release manifest. */
export async function collectReleaseArtifacts(input, output, version) {
  if (!exactVersion.test(version)) throw new Error("Release delivery requires an exact version.");
  separateDirectories(input, output);
  const files = [];
  for (const target of releaseTargets) {
    const directory = join(input, `zelavis-${target}`);
    const expected = ["tar.gz", "zip"].map((extension) => `zelavis-${version}-${target}.${extension}`);
    if (target.startsWith("linux")) expected.push(`zelavis_${version.replace(/-([0-9A-Za-z])/g, "~$1")}_${target.endsWith("x64") ? "amd64" : "arm64"}.deb`);
    const actual = (await readdir(directory)).filter((name) => name !== "SHA256SUMS").sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected.sort())) throw new Error(`Incomplete or unexpected artifacts for ${target}.`);
    const lines = (await readFile(join(directory, "SHA256SUMS"), "utf8")).trim().split("\n");
    const digests = new Map();
    for (const line of lines) {
      const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
      if (!match || digests.has(match[2]) || !expected.includes(match[2])) throw new Error(`Invalid checksum manifest for ${target}.`);
      digests.set(match[2], match[1]);
    }
    for (const name of expected) {
      const file = join(directory, name);
      if (await fileChecksum(file) !== digests.get(name)) throw new Error(`Release checksum mismatch: ${name}.`);
      files.push({ file, name });
    }
  }
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Release delivery output must be empty.");
  for (const { file, name } of files) await copyFile(file, join(output, name));
  await writeChecksums(output);
  return files.map(({ name }) => name);
}

/** Provider-neutral static roots; deployment credentials remain owner-provided. */
export async function buildPublicDelivery(artifacts, output, version, { apt } = {}) {
  if (!exactVersion.test(version)) throw new Error("Public delivery requires an exact version.");
  separateDirectories(artifacts, output);
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../installers");
  const script = await readFile(join(source, "install.sh"), "utf8");
  const channel = version.includes("-") ? "alpha" : "latest";
  const immutable = join(output, "downloads", "releases", version);
  const aliases = join(output, "downloads", channel);
  const manifest = await readFile(join(artifacts, "SHA256SUMS"), "utf8");
  const entries = [];
  const seen = new Set();
  for (const line of manifest.trim().split("\n")) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    if (!match || seen.has(match[2]) || !/\.(tar\.gz|zip|deb)$/.test(match[2])) throw new Error("Invalid public checksum manifest.");
    const [, digest, name] = match;
    seen.add(name);
    if (await fileChecksum(join(artifacts, name)) !== digest) throw new Error(`Public artifact checksum mismatch: ${name}.`);
    entries.push({ digest, name });
  }
  if (apt) {
    separateDirectories(apt, output);
    for (const name of ["zelavis-archive-keyring.gpg", "dists/stable/InRelease", "dists/stable/Release.gpg"]) await readFile(join(apt, name));
  }
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Public delivery output must be empty.");
  await mkdir(immutable, { recursive: true });
  await mkdir(aliases, { recursive: true });
  await mkdir(join(output, "site"), { recursive: true });
  await writeFile(join(output, "site", "install.sh"), script, { mode: 0o755 });
  for (const { name, digest } of entries) {
    await copyFile(join(artifacts, name), join(immutable, name));
    await writeFile(join(immutable, `${name}.sha256`), `${digest}\n`);
    if (name.endsWith(".tar.gz") || name.endsWith(".zip")) {
      const alias = name.replace(`zelavis-${version}-`, "zelavis-");
      await copyFile(join(artifacts, name), join(aliases, alias));
      await writeFile(join(aliases, `${alias}.sha256`), `${digest}\n`);
    }
  }
  await writeFile(join(immutable, "SHA256SUMS"), manifest);
  await writeFile(join(aliases, "version"), `${version}\n`);
  if (apt) await cp(apt, join(output, "apt"), { recursive: true });
  return channel;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, input, output, version, apt] = process.argv.slice(2);
  if (!input || !output || !version || !["collect", "public"].includes(command)) throw new Error("Usage: release-delivery.mjs collect|public <input> <output> <version> [signed-apt-directory]");
  if (command === "collect") await collectReleaseArtifacts(resolve(input), resolve(output), version);
  else await buildPublicDelivery(resolve(input), resolve(output), version, { apt });
}
