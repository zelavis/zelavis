import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// Software pins and recipe package revisions are independent. Add a changeset
// when updating the pin or changing provisioning behavior.
const response = await fetch("https://api.wordpress.org/core/version-check/1.7/");
if (!response.ok) {
  throw new Error(`WordPress version API returned HTTP ${response.status}.`);
}
const payload = await response.json();
const offer = payload?.offers?.find(
  (candidate) =>
    candidate?.response === "upgrade" &&
    candidate?.locale === "en_US" &&
    typeof candidate?.version === "string",
);
const release = offer?.version;
if (!release || !/^\d+\.\d+(?:\.\d+)?$/.test(release)) {
  throw new Error("WordPress version API did not return a stable release.");
}

// Pin the archive digest. wordpress.org also publishes a SHA-1 next to it; the
// download must agree with that before its SHA-256 is trusted as the pin.
const archiveUrl = `https://wordpress.org/wordpress-${release}.tar.gz`;
const archive = await fetch(archiveUrl);
if (!archive.ok) throw new Error(`Downloading ${archiveUrl} returned HTTP ${archive.status}.`);
const bytes = Buffer.from(await archive.arrayBuffer());
const published = await fetch(`${archiveUrl}.sha1`);
if (!published.ok) throw new Error(`The published SHA-1 returned HTTP ${published.status}.`);
if ((await published.text()).trim().split(/\s+/)[0] !== createHash("sha1").update(bytes).digest("hex")) {
  throw new Error(`The WordPress ${release} download does not match its published SHA-1.`);
}
const sha256 = createHash("sha256").update(bytes).digest("hex");
// The pin lives in the recipe's own manifest, which is frozen into each Project with the package,
// so the download is checked against something wordpress.org cannot change after the fact.
const manifestFile = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
const install = manifest.zelavis.project.install;
const entry = { version: release, archive: archiveUrl, sha256, maxBytes: 64 * 1024 * 1024 };
// Earlier releases stay on offer (a Project that chose one keeps it); the newest eight are kept.
install.software = [...install.software.filter((candidate) => candidate.version !== release), entry].slice(-8);
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Pinned WordPress ${release}; add a recipe changeset before publishing.`);
