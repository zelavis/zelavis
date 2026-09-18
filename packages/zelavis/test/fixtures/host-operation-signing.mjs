import { signHostOperationManifest } from "../../dist/core/deployment/index.js";

/** A throwaway release key and the trust store that accepts it. */
export async function createReleaseSigner({ keyId = "test-release-2026", notBefore, notAfter } = {}) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", publicKey));
  const key = {
    keyId,
    publicKey: Buffer.from(raw).toString("base64"),
    notBefore: notBefore ?? new Date(Date.now() - 86_400_000).toISOString(),
    notAfter: notAfter ?? new Date(Date.now() + 86_400_000).toISOString(),
  };
  return {
    key,
    privateKey,
    trust: { keys: [key] },
    sign: (manifest, options = {}) =>
      signHostOperationManifest({ manifest, keyId, privateKey, ...options }),
  };
}
