// Release-host tool: creates a host-operation signing key.
//
//   node distribution/scripts/generate-operation-signing-key.mjs <key-id> <private-key-file> [valid-days]
//
// Writes the private key (base64 PKCS8, 0600) to a file outside the repository
// and prints the trust entry to add to release.json `operationTrust.keys`.
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { generateOperationSigningKey } from "./operation-signing.mjs";

const [keyId, privateKeyFile, validDays = "365"] = process.argv.slice(2);
if (!keyId || !privateKeyFile) {
  console.error("Usage: generate-operation-signing-key.mjs <key-id> <private-key-file> [valid-days]");
  process.exit(1);
}
if (resolve(privateKeyFile).startsWith(resolve(new URL("../..", import.meta.url).pathname))) {
  console.error("Refusing to write a private key inside the repository.");
  process.exit(1);
}
const { privateKeyPkcs8, trustEntry } = await generateOperationSigningKey({ keyId, validDays: Number(validDays) });
await writeFile(privateKeyFile, `${privateKeyPkcs8}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(trustEntry, null, 2));
