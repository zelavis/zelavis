// Stages the host operations a release ships: each `<id>/<version>/` source
// (an `artifact` and an `operation.json` without a digest) becomes the
// installed layout `<id>/<version>/{artifact, manifest.json}`, with the digest
// computed here. Manifests are plain: the installed tree is root-owned and the
// Agent refuses it otherwise, so there is nothing to sign.
// Published as a generated installation asset; never maintain another copy.
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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

/**
 * An operation that needs files (a build script) carries them inside its own artifact, so the digest covers
 * them and nothing else has to be installed. `embed` in operation.json maps a name to a path relative to the
 * operations source directory; the artifact marks each place with `@@EMBED:<name>@@`, replaced here by the
 * file's bytes as base64 (a single line of [A-Za-z0-9+/=], safe in a shell here-document or quote).
 */
async function withEmbeddedFiles(entry, embed, source) {
  const bytes = await readFile(join(entry.directory, "artifact"));
  if (embed === undefined) return bytes;
  if (typeof embed !== "object" || embed === null) throw new Error(`${entry.id}: embed must map names to paths.`);
  let text = bytes.toString("utf8");
  for (const [name, path] of Object.entries(embed)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof path !== "string") throw new Error(`${entry.id}: invalid embed entry "${name}".`);
    const token = `@@EMBED:${name}@@`;
    if (!text.includes(token)) throw new Error(`${entry.id}: the artifact never uses ${token}.`);
    text = text.split(token).join((await readFile(join(source, path))).toString("base64"));
  }
  if (/@@EMBED:/.test(text)) throw new Error(`${entry.id}: the artifact marks a file that operation.json does not embed.`);
  return Buffer.from(text, "utf8");
}

/** `validate` is `validateHostOperationManifest` from the built Platform. */
export async function stageOperations({ source, output, validate }) {
  await mkdir(output, { recursive: true, mode: 0o755 });
  const staged = [];
  for (const entry of await operationSources(source)) {
    const { embed, ...template } = JSON.parse(await readFile(join(entry.directory, "operation.json"), "utf8"));
    if (template.id !== entry.id || template.version !== entry.version || "sha256" in template) {
      throw new Error(`${entry.directory}/operation.json must match its directory and omit sha256.`);
    }
    const artifact = await withEmbeddedFiles(entry, embed, source);
    const manifest = validate({ ...template, sha256: createHash("sha256").update(artifact).digest("hex") });
    const target = join(output, entry.id, entry.version);
    await mkdir(target, { recursive: true, mode: 0o755 });
    await writeFile(join(target, "artifact"), artifact);
    // The Agent requires every artifact to be executable, including interpreter-backed scripts.
    await chmod(join(target, "artifact"), 0o755);
    await writeFile(join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    staged.push(`${entry.id}@${entry.version}`);
  }
  return staged;
}
