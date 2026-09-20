import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  algorithm: "AES-256-GCM";
}

export interface P256KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  privateKeyPem: string;
  publicKeyPem: string;
}

export interface JwsFlattenedJson {
  protected: string;
  payload: string;
  signature: string;
}

export interface JwsProtectedHeader {
  alg: "ES256";
  nonce: string;
  url: string;
  jwk?: {
    kty: string;
    crv: string;
    x: string;
    y: string;
  };
  kid?: string;
}

// ---------------------------------------------------------------------------
// Base64URL Helpers
// ---------------------------------------------------------------------------

export function toBase64Url(input: Buffer | Uint8Array | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function fromBase64Url(input: string): Buffer {
  let base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  return Buffer.from(base64, "base64");
}

// ---------------------------------------------------------------------------
// Secret Encryption / Decryption (AES-256-GCM)
// ---------------------------------------------------------------------------

function deriveAes256Key(secret: string | Buffer): Buffer {
  if (Buffer.isBuffer(secret) && secret.length === 32) {
    return secret;
  }
  return createHash("sha256").update(secret).digest();
}

/**
 * Encrypts sensitive string material (e.g. private keys) using AES-256-GCM.
 */
export function encryptSecret(
  plaintext: string,
  secretKey: string | Buffer,
): EncryptedSecret {
  const key = deriveAes256Key(secretKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return {
    ciphertext: toBase64Url(encrypted),
    iv: toBase64Url(iv),
    tag: toBase64Url(tag),
    algorithm: "AES-256-GCM",
  };
}

/**
 * Decrypts sensitive string material using AES-256-GCM.
 */
export function decryptSecret(
  encrypted: EncryptedSecret,
  secretKey: string | Buffer,
): string {
  const key = deriveAes256Key(secretKey);
  const iv = fromBase64Url(encrypted.iv);
  const tag = fromBase64Url(encrypted.tag);
  const ciphertext = fromBase64Url(encrypted.ciphertext);

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

// ---------------------------------------------------------------------------
// P-256 Key Management & JWK
// ---------------------------------------------------------------------------

/**
 * Generates an ECDSA P-256 (prime256v1) key pair.
 */
export function generateP256KeyPair(): P256KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });

  return {
    privateKey,
    publicKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/**
 * Exports public P-256 key as RFC 7517 JWK.
 */
export function exportP256Jwk(publicKey: KeyObject): {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
} {
  const jwk = publicKey.export({ format: "jwk" });
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) {
    throw new Error("Invalid P-256 public key for JWK export.");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: jwk.x,
    y: jwk.y,
  };
}

/**
 * Calculates RFC 7638 SHA-256 JWK Thumbprint for a P-256 public key.
 */
export function calculateP256JwkThumbprint(jwk: {
  kty: string;
  crv: string;
  x: string;
  y: string;
}): string {
  // Required fields in strict lexicographical order per RFC 7638: crv, kty, x, y
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });

  return toBase64Url(createHash("sha256").update(canonical).digest());
}

// ---------------------------------------------------------------------------
// JWS Flattened Signing (RFC 7515 & RFC 8555)
// ---------------------------------------------------------------------------

export interface SignJwsOptions {
  privateKey: KeyObject;
  header: JwsProtectedHeader;
  payload: Record<string, unknown> | string;
}

/**
 * Creates a flattened JWS JSON signature for an ACME request using ES256 (P-256 + SHA-256).
 */
export function signJws(options: SignJwsOptions): JwsFlattenedJson {
  const { privateKey, header, payload } = options;

  const protectedB64 = toBase64Url(JSON.stringify(header));
  const payloadB64 =
    typeof payload === "string"
      ? toBase64Url(payload)
      : toBase64Url(JSON.stringify(payload));

  const signingInput = Buffer.from(`${protectedB64}.${payloadB64}`, "ascii");

  // ES256 signature must be 64-byte IEEE P1363 (r || s), not ASN.1 DER
  const signature = createSign("SHA256").update(signingInput).sign({
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  return {
    protected: protectedB64,
    payload: payloadB64,
    signature: toBase64Url(signature),
  };
}

// ---------------------------------------------------------------------------
// PKCS#10 CSR Generator (RFC 2986)
// ---------------------------------------------------------------------------

function derLength(len: number): Buffer {
  if (len < 128) {
    return Buffer.from([len]);
  }
  const bytes: number[] = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function derSequence(content: Buffer): Buffer {
  return derTag(0x30, content);
}

function derOid(oidStr: string): Buffer {
  const parts = oidStr.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    const octets: number[] = [];
    octets.push(val & 0x7f);
    while ((val >>= 7) > 0) {
      octets.unshift((val & 0x7f) | 0x80);
    }
    bytes.push(...octets);
  }
  return derTag(0x06, Buffer.from(bytes));
}

/**
 * Generates an ASN.1 DER encoded PKCS#10 Certificate Signing Request (CSR).
 *
 * Fully compliant with RFC 2986 and RFC 5280.
 */
export function generateCsrDer(options: {
  keyPair: P256KeyPair;
  commonName: string;
  sanList?: readonly string[];
}): Buffer {
  const { keyPair, commonName, sanList = [] } = options;

  // 1. Subject Name: CN=commonName
  const cnOid = derOid("2.5.4.3"); // id-at-commonName
  const cnVal = derTag(0x0c, Buffer.from(commonName, "utf8")); // UTF8String
  const rdnCn = derTag(0x31, derSequence(Buffer.concat([cnOid, cnVal]))); // SET OF AttributeTypeAndValue
  const subject = derSequence(rdnCn);

  // 2. SubjectPublicKeyInfo (DER format directly exported from KeyObject)
  const spki = keyPair.publicKey.export({ type: "spki", format: "der" });

  // 3. Subject Alternative Name (SAN) Extension
  const allSanNames = [
    commonName,
    ...sanList.filter((n) => n.toLowerCase() !== commonName.toLowerCase()),
  ];
  const sanEntries = allSanNames.map((name) =>
    derTag(0x82, Buffer.from(name, "utf8")),
  ); // [2] dNSName
  const sanSeq = derSequence(Buffer.concat(sanEntries));

  const sanOid = derOid("2.5.29.17"); // id-ce-subjectAltName
  const sanExtnValue = derTag(0x04, sanSeq); // OCTET STRING containing DER SEQUENCE
  const extn = derSequence(Buffer.concat([sanOid, sanExtnValue]));
  const extensionsSeq = derSequence(extn);

  // 4. Attributes: extensionRequest (1.2.840.113549.1.9.14)
  const extReqOid = derOid("1.2.840.113549.1.9.14");
  const extReqSet = derTag(0x31, extensionsSeq); // SET OF
  const attr = derSequence(Buffer.concat([extReqOid, extReqSet]));
  const attributes = derTag(0xa0, attr); // [0] IMPLICIT Attributes

  // 5. CertificationRequestInfo: version=0
  const version = derTag(0x02, Buffer.from([0x00])); // INTEGER 0
  const cri = derSequence(Buffer.concat([version, subject, spki, attributes]));

  // 6. Sign CRI with ecdsa-with-SHA256 (standard ASN.1 DER signature for PKCS#10)
  const sigAlg = derSequence(derOid("1.2.840.10045.4.3.2")); // ecdsa-with-SHA256
  const sign = createSign("SHA256");
  sign.update(cri);
  const signature = sign.sign(keyPair.privateKey); // ASN.1 DER signature

  // 7. Signature BIT STRING: 0 unused bits followed by signature bytes
  const bitStringSig = derTag(
    0x03,
    Buffer.concat([Buffer.from([0x00]), signature]),
  );

  // 8. Outer CertificationRequest SEQUENCE
  return derSequence(Buffer.concat([cri, sigAlg, bitStringSig]));
}
