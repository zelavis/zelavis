import { chmod, copyFile, cp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { Effect } from "effect";
import { sealNodeRuntimeArtifact } from "../../dist/adapters/_node-runtime-artifact.js";

/** Hermetic executable fixture: actual compiled engine, contained production
 * dependencies and a copied private Node. No network or developer symlinks. */
export async function stageEngineFixture(packageRoot, release, version) {
  const platform = join(release, "platform");
  await mkdir(platform, { recursive: true });
  await cp(join(packageRoot, "dist"), join(platform, "dist"), { recursive: true });
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  await writeFile(join(platform, "package.json"), JSON.stringify({ ...manifest, version }));
  const dependencies = new Map();
  const dependencyStore = join(platform, "node_modules", ".fixture");
  async function collect(name, from, into) {
    const entry = createRequire(join(from, "package.json")).resolve(name);
    let directory = dirname(await realpath(entry)), found;
    while (directory !== dirname(directory)) {
      try { const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); if (value.name === name) { found = value; break; } } catch {}
      directory = dirname(directory);
    }
    if (!found) throw new Error(`Cannot stage production dependency ${name}.`);
    // Key by the resolved installation. Different consumers can need different
    // versions, or a separate instance of the same version for peer dependencies.
    let staged = dependencies.get(directory);
    if (staged === undefined) {
      staged = join(dependencyStore, String(dependencies.size), "package");
      dependencies.set(directory, staged);
      await mkdir(dirname(staged), { recursive: true });
      await cp(directory, staged, { recursive: true, dereference: true });
      for (const dependency of Object.keys(found.dependencies ?? {})) {
        await collect(dependency, directory, join(staged, "node_modules"));
      }
    }
    const link = join(into, name);
    await mkdir(dirname(link), { recursive: true });
    await symlink(relative(dirname(link), staged), link);
  }
  for (const dependency of Object.keys(manifest.dependencies)) await collect(dependency, packageRoot, join(platform, "node_modules"));
  await symlink("..", join(platform, "node_modules/zelavis"));
  // Match the published service payload, not every service in the checkout.
  // Opt-in experiments need not have dist/ and must not enter installed engines.
  for (const path of manifest.files.filter((path) => path.startsWith("services/"))) {
    const destination = join(platform, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(packageRoot, path), destination, { recursive: true });
  }
  await mkdir(join(release, "runtime/node/bin"), { recursive: true });
  await copyFile(process.execPath, join(release, "runtime/node/bin/node"));
  await chmod(join(release, "runtime/node/bin/node"), 0o755);
  await mkdir(join(release, "bin"));
  await writeFile(join(release, "bin/zelavis"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(release, "manifest.json"), JSON.stringify({ name: "zelavis", version, platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node }));
  return await Effect.runPromise(sealNodeRuntimeArtifact(release));
}
