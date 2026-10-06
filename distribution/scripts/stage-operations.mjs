// Stages the host operations a release ships: each `<id>/<version>/` source
// (an `artifact` and an `operation.json` without a digest) becomes the
// installed layout `<id>/<version>/{artifact, manifest.json}`, with the digest
// computed here. Manifests are plain: the installed tree is root-owned and the
// Agent refuses it otherwise, so there is nothing to sign.
// Published as a generated installation asset; never maintain another copy.
import { chmod, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

async function operationSources(source) {
  const entries = [];
  const ids = await readdir(source, { withFileTypes: true }).catch(() => []);
  for (const id of ids.filter((entry) => entry.isDirectory())) {
    for (const version of (await readdir(join(source, id.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      entries.push({ id: id.name, version: version.name, directory: join(source, id.name, version.name) });
    }
  }
  return entries;
}

/** `validate` is `validateHostOperationManifest` from the built Platform. */
export async function stageOperations({ source, output, validate }) {
  await mkdir(output, { recursive: true, mode: 0o755 });
  const staged = [];
  for (const entry of await operationSources(source)) {
    const template = JSON.parse(await readFile(join(entry.directory, "operation.json"), "utf8"));
    if (template.id !== entry.id || template.version !== entry.version || "sha256" in template) {
      throw new Error(`${entry.directory}/operation.json must match its directory and omit sha256.`);
    }
    const artifact = await readFile(join(entry.directory, "artifact"));
    const manifest = validate({ ...template, sha256: createHash("sha256").update(artifact).digest("hex") });
    const target = join(output, entry.id, entry.version);
    await mkdir(target, { recursive: true, mode: 0o755 });
    await copyFile(join(entry.directory, "artifact"), join(target, "artifact"));
    // The Agent requires every artifact to be executable, including interpreter-backed scripts.
    await chmod(join(target, "artifact"), 0o755);
    await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    staged.push(`${entry.id}@${entry.version}`);
  }
  return staged;
}
