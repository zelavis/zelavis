import { chmod, copyFile, cp, mkdir, readFile, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  async function collect(name, from) {
    const entry = createRequire(join(from, "package.json")).resolve(name);
    let directory = dirname(await realpath(entry)), found;
    while (directory !== dirname(directory)) {
      try { const value = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); if (value.name === name) { found = value; break; } } catch {}
      directory = dirname(directory);
    }
    if (!found) throw new Error(`Cannot stage production dependency ${name}.`);
    if (dependencies.has(name)) {
      if (dependencies.get(name) !== found.version) throw new Error(`Fixture dependency versions conflict: ${name}.`);
      return;
    }
    dependencies.set(name, found.version);
    await mkdir(dirname(join(platform, "node_modules", name)), { recursive: true });
    await cp(directory, join(platform, "node_modules", name), { recursive: true, dereference: true });
    for (const dependency of Object.keys(found.dependencies ?? {})) await collect(dependency, directory);
  }
  for (const dependency of Object.keys(manifest.dependencies)) await collect(dependency, packageRoot);
  await symlink("..", join(platform, "node_modules/zelavis"));
  for (const service of await readdir(join(packageRoot, "services"))) {
    const source = join(packageRoot, "services", service), destination = join(platform, "services", service);
    await mkdir(destination, { recursive: true });
    await copyFile(join(source, "package.json"), join(destination, "package.json"));
    await cp(join(source, "dist"), join(destination, "dist"), { recursive: true });
    try { await cp(join(source, "build/client"), join(destination, "build/client"), { recursive: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await mkdir(join(release, "runtime/node/bin"), { recursive: true });
  await copyFile(process.execPath, join(release, "runtime/node/bin/node"));
  await chmod(join(release, "runtime/node/bin/node"), 0o755);
  await mkdir(join(release, "bin"));
  await writeFile(join(release, "bin/zelavis"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(join(release, "manifest.json"), JSON.stringify({ name: "zelavis", version, platform: process.platform, architecture: process.arch, nodeVersion: process.versions.node }));
  return await Effect.runPromise(sealNodeRuntimeArtifact(release));
}
