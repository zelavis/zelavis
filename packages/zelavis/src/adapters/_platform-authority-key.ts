/**
 * Custody of the Platform's Agent authority key.
 *
 * The private key stays in one 0600 file the Platform owns. The public half is
 * written beside it as a trust-store file an Agent reads with
 * `--platform-authority`; the Agent never receives anything secret.
 *
 * Rotation: a key is used for signing until 30 days before it expires, then a
 * new key signs and the old one stays in the trust file until it expires. An
 * Agent reads the trust file at start, so it must be restarted within that
 * overlap to accept the new key.
 */
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ZelavisPlatformAuthoritySigner } from "../platform/host-operations.js";
import type { ZelavisHostOperationTrustStore } from "../core/deployment/index.js";

const KEY_FILE = "signing-keys.json";
export const PLATFORM_AUTHORITY_TRUST_FILE = "platform-authority.json";
const VALIDITY_MS = 365 * 86_400_000;
const ROTATE_BEFORE_MS = 30 * 86_400_000;

interface StoredKey {
  readonly keyId: string;
  readonly privateKeyPkcs8: string;
  readonly publicKey: string;
  readonly notBefore: string;
  readonly notAfter: string;
}

async function generate(now: number): Promise<StoredKey> {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"],
  );
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw))]
    .slice(0, 8).map((value) => value.toString(16).padStart(2, "0")).join("");
  return {
    keyId: `platform-${fingerprint}`,
    privateKeyPkcs8: Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey)).toString("base64"),
    publicKey: Buffer.from(raw).toString("base64"),
    notBefore: new Date(now - 60_000).toISOString(),
    notAfter: new Date(now + VALIDITY_MS).toISOString(),
  };
}

async function writeAtomically(path: string, body: string, mode: number) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { mode, flag: "w" });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

export async function readOrCreatePlatformAuthorityKey(
  directory: string,
  now = Date.now(),
): Promise<{
  readonly signer: ZelavisPlatformAuthoritySigner;
  readonly trustFile: string;
  readonly trust: ZelavisHostOperationTrustStore;
}> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const keyPath = join(directory, KEY_FILE);
  let keys: StoredKey[] = [];
  const stats = await lstat(keyPath).catch(() => undefined);
  if (stats) {
    if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) {
      throw new Error(`Platform authority key file ${keyPath} must be a 0600 regular file.`);
    }
    keys = (JSON.parse(await readFile(keyPath, "utf8")) as { keys: StoredKey[] }).keys;
  }
  const live = keys.filter((key) => Date.parse(key.notAfter) > now);
  let current = live.at(-1);
  if (!current || Date.parse(current.notAfter) - now < ROTATE_BEFORE_MS) {
    current = await generate(now);
    live.push(current);
  }
  if (live.length !== keys.length || live.at(-1) !== keys.at(-1)) {
    await writeAtomically(keyPath, `${JSON.stringify({ keys: live }, null, 2)}\n`, 0o600);
  }
  const trust: ZelavisHostOperationTrustStore = {
    keys: live.map(({ keyId, publicKey, notBefore, notAfter }) => ({ keyId, publicKey, notBefore, notAfter })),
  };
  const trustFile = join(directory, PLATFORM_AUTHORITY_TRUST_FILE);
  await writeAtomically(trustFile, `${JSON.stringify(trust, null, 2)}\n`, 0o644);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(current.privateKeyPkcs8, "base64"),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  return { signer: { keyId: current.keyId, privateKey }, trustFile, trust };
}
