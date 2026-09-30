import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The recipe version is the package version, so a new WordPress release is a
// new package version. WordPress names its x.y.0 releases x.y; the package is
// semver, so 7.1 becomes 7.1.0 and 6.9.4 stays 6.9.4 (see `wordpressRelease`).
const packageFile = fileURLToPath(new URL("../package.json", import.meta.url));
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
const version = release.split(".").length === 2 ? `${release}.0` : release;

const manifest = JSON.parse(await readFile(packageFile, "utf8"));
if (manifest.version === version) {
  console.log(`The WordPress recipe is already at ${version}.`);
} else {
  manifest.version = version;
  await writeFile(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Updated the WordPress recipe to ${version}.`);
}
