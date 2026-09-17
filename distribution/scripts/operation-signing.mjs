// Release signing for host operations. Used by build-stage.mjs; importable by
// tests. The private key never touches the repository: it comes from the
// release environment and is only held in memory here.
import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const deployment = () => import("../../packages/zelavis/dist/core/deployment/index.js");

export async function importOperationSigningKey(pkcs8Base64) {
  return crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(pkcs8Base64, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

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
 * Signs every operation under `source` into `output`.
 *
 * With operations present and no key, the build fails unless `allowSkip`
 * is set, in which case operations are omitted rather than shipped unsigned.
 * Every signature is verified against the release trust store so a build
 * cannot ship operations the installed trust store would reject.
 */
export async function stageSignedOperations({ source, output, trust, signingKey, keyId, allowSkip = false, signedAt }) {
  const sources = await operationSources(source);
  await mkdir(output, { recursive: true, mode: 0o755 });
  if (sources.length === 0) return { signed: [], skipped: false };
  // Before any release key is published nothing could verify a signature, so
  // operations are omitted rather than failing every build; once a key is in
  // the trust store, a missing signing key is an error.
  if ((!signingKey || !keyId) && (trust?.keys?.length ?? 0) === 0) {
    return { signed: [], skipped: true, reason: "release.json operationTrust lists no keys" };
  }
  if (!signingKey || !keyId) {
    if (allowSkip) return { signed: [], skipped: true };
    throw new Error(
      `${sources.length} host operation(s) need signing: set ZELAVIS_OPERATION_SIGNING_KEY and ZELAVIS_OPERATION_SIGNING_KEY_ID, or ZELAVIS_SKIP_UNSIGNED_OPERATIONS=1 to omit them.`,
    );
  }
  const { signHostOperationManifest, verifySignedHostOperationManifest } = await deployment();
  const privateKey = await importOperationSigningKey(signingKey);
  const signed = [];
  for (const entry of sources) {
    const template = JSON.parse(await readFile(join(entry.directory, "operation.json"), "utf8"));
    if (template.id !== entry.id || template.version !== entry.version || "sha256" in template) {
      throw new Error(`${entry.directory}/operation.json must match its directory and omit sha256.`);
    }
    const artifact = await readFile(join(entry.directory, "artifact"));
    const manifest = { ...template, sha256: createHash("sha256").update(artifact).digest("hex") };
    const envelope = await signHostOperationManifest({ manifest, keyId, privateKey, ...(signedAt ? { signedAt } : {}) });
    await verifySignedHostOperationManifest(envelope, trust);
    const target = join(output, entry.id, entry.version);
    await mkdir(target, { recursive: true, mode: 0o755 });
    await copyFile(join(entry.directory, "artifact"), join(target, "artifact"));
    const mode = (await stat(join(entry.directory, "artifact"))).mode & 0o111 ? 0o755 : 0o644;
    await chmod(join(target, "artifact"), mode);
    await writeFile(join(target, "manifest.json"), `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o644 });
    signed.push(`${entry.id}@${entry.version}`);
  }
  return { signed, skipped: false };
}

/** A new release key: private PKCS8 (base64) and the trust entry to publish. */
export async function generateOperationSigningKey({ keyId, notBefore = new Date(), validDays = 365 }) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return {
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64"),
    trustEntry: {
      keyId,
      publicKey: Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64"),
      notBefore: notBefore.toISOString(),
      notAfter: new Date(notBefore.getTime() + validDays * 86_400_000).toISOString(),
    },
  };
}
