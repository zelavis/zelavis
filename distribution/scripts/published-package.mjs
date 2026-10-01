import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const exactVersion = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

/** Native compilation happens on the release runner, using the private Node ABI. */
export async function stagePublishedPackage(output, version, run = execFileSync) {
  if (!exactVersion.test(version)) throw new Error("Published staging requires an exact version.");
  const project = join(output, ".npm-project");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "package.json"), '{"private":true}\n');
  const node = join(output, "runtime", "node", "bin", "node");
  const npm = join(output, "runtime", "node", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  run(node, [npm, "install", "--prefix", project, "--registry=https://registry.npmjs.org", "--omit=dev", "--no-audit", "--no-fund", "--install-strategy=hoisted", `zelavis@${version}`], {
    stdio: "inherit",
    env: { ...process.env, PATH: `${join(output, "runtime", "node", "bin")}:${process.env.PATH}` },
  });
  const packageDirectory = join(project, "node_modules", "zelavis");
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (manifest.name !== "zelavis" || manifest.version !== version) throw new Error("Published package identity mismatch.");
  await rename(packageDirectory, join(output, "platform"));
  await rename(join(project, "node_modules"), join(output, "platform", "node_modules"));
  // npm's .bin links and self imports retain their original relative targets.
  await symlink("..", join(output, "platform", "node_modules", "zelavis"));
  await rm(project, { recursive: true, force: true });
  return manifest;
}
