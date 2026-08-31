import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const serviceFile = fileURLToPath(
  new URL("../src/wordpress/wordpress-service.ts", import.meta.url),
);
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
const version = offer?.version;
if (!version || !/^\d+\.\d+(?:\.\d+)?$/.test(version)) {
  throw new Error("WordPress version API did not return a stable release.");
}

const current = await readFile(serviceFile, "utf8");
const next = current.replace(
  /export const WORDPRESS_VERSION = "[^"]+";/,
  `export const WORDPRESS_VERSION = "${version}";`,
);
if (next === current) {
  console.log(`WordPress recipe is already pinned to ${version}.`);
} else {
  await writeFile(serviceFile, next);
  console.log(`Updated the WordPress Project recipe to ${version}.`);
}
