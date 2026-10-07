import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { isIP } from "node:net";

/**
 * A self-signed TLS certificate for a worker Agent, made with `node:crypto`
 * alone so a fresh server needs no `openssl` and no compiler.
 *
 * The Platform pins this exact certificate as the Agent's only trust anchor and
 * connects with hostname verification, so the names the Agent will be dialed by must be in
 * the certificate: an IP address is an `iPAddress` entry and anything else a
 * `dNSName`. The key never leaves the machine that generated it.
 *
 * Authority and bounds: pure computation, no I/O. The key is P-256, the
 * signature ECDSA with SHA-256, the validity bounded, and every name validated
 * before any byte is encoded.
 */

const MAX_NAMES = 8;
const MAX_NAME_LENGTH = 253;
const DEFAULT_VALIDITY_DAYS = 825;
const MAX_VALIDITY_DAYS = 3650;
const DAY_MS = 86_400_000;

export interface AgentCertificateInput {
  /** Hostnames and IP addresses the Platform will dial the Agent by. */
  readonly names: readonly string[];
  readonly validityDays?: number;
  /** Injected so tests can pin the clock; defaults to now. */
  readonly now?: number;
}

export interface AgentCertificate {
  readonly keyPem: string;
  readonly certPem: string;
  readonly notBefore: number;
  readonly notAfter: number;
}

const der = (tag: number, ...parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const header = length < 0x80
    ? [tag, length]
    : length <= 0xff ? [tag, 0x81, length]
    : length <= 0xffff ? [tag, 0x82, length >> 8, length & 0xff]
    : (() => { throw new RangeError("DER value too large."); })();
  const result = new Uint8Array(header.length + length);
  result.set(header, 0);
  let offset = header.length;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

const oid = (dotted: string): Uint8Array => {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [arcs[0]! * 40 + arcs[1]!];
  for (const arc of arcs.slice(2)) {
    const chunk = [arc & 0x7f];
    for (let rest = arc >> 7; rest > 0; rest >>= 7) chunk.unshift((rest & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Uint8Array.from(bytes));
};

const utf8 = (text: string) => new TextEncoder().encode(text);
const sequence = (...parts: readonly Uint8Array[]) => der(0x30, ...parts);
const set = (...parts: readonly Uint8Array[]) => der(0x31, ...parts);
/** `unused` is the count of unused bits in the final byte. */
const bitString = (bytes: Uint8Array, unused = 0) => der(0x03, Uint8Array.from([unused, ...bytes]));
const octetString = (bytes: Uint8Array) => der(0x04, bytes);

/** UTCTime, valid for years 1950 to 2049, which bounds the validity this accepts. */
function utcTime(at: number): Uint8Array {
  const date = new Date(at);
  const year = date.getUTCFullYear();
  if (year < 1950 || year > 2049) throw new RangeError("Certificate validity must end before 2050.");
  const two = (value: number) => String(value).padStart(2, "0");
  const text = `${two(year % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`;
  return der(0x17, utf8(text));
}

/** A DNS label sequence: letters, digits, hyphen and dots, without empty labels. */
const HOSTNAME = /^(?=.{1,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

function ipBytes(address: string): Uint8Array {
  if (isIP(address) === 4) return Uint8Array.from(address.split(".").map(Number));
  // IPv6: expand `::` and parse 16-bit groups.
  const [head = "", tail = ""] = address.split("::");
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const left = groups(head);
  const right = address.includes("::") ? groups(tail) : [];
  const missing = 8 - left.length - right.length;
  const all = address.includes("::") ? [...left, ...Array(missing).fill("0"), ...right] : left;
  const bytes: number[] = [];
  for (const group of all) {
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return Uint8Array.from(bytes);
}

function generalName(name: string): Uint8Array {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) throw new TypeError("An Agent certificate name is empty or too long.");
  const version = isIP(name);
  if (version !== 0) return der(0x87, ipBytes(name));
  if (!HOSTNAME.test(name)) throw new TypeError(`"${name}" is not a valid hostname or IP address.`);
  return der(0x82, utf8(name));
}

export function generateAgentCertificate(input: AgentCertificateInput): AgentCertificate {
  if (!Array.isArray(input.names) || input.names.length === 0 || input.names.length > MAX_NAMES) {
    throw new TypeError(`An Agent certificate needs between 1 and ${MAX_NAMES} names.`);
  }
  const validityDays = input.validityDays ?? DEFAULT_VALIDITY_DAYS;
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > MAX_VALIDITY_DAYS) {
    throw new RangeError(`Validity must be a whole number of days from 1 to ${MAX_VALIDITY_DAYS}.`);
  }
  const names = [...new Set(input.names)];
  const subjectAltName = sequence(...names.map(generalName));

  const now = input.now ?? Date.now();
  // A day of backdating tolerates a worker whose clock is slightly behind the Platform's.
  const notBefore = Math.floor((now - DAY_MS) / 1000) * 1000;
  const notAfter = Math.floor((now + validityDays * DAY_MS) / 1000) * 1000;

  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(oid("1.2.840.10045.4.3.2"));
  const subject = sequence(set(sequence(oid("2.5.4.3"), der(0x0c, utf8("zelavis-agent")))));
  // Positive, non-zero, 16 random bytes: the leading byte has its top bit cleared and is never 0.
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) || 1;

  const extension = (id: string, value: Uint8Array, critical = false) =>
    sequence(oid(id), ...(critical ? [der(0x01, Uint8Array.from([0xff]))] : []), octetString(value));
  const extensions = der(0xa3, sequence(
    // A self-signed root, as `openssl req -x509` makes: the Platform pins it as the only trust
    // anchor for this Agent, and verification everywhere treats a non-CA certificate as unable
    // to be its own issuer. `pathlen:0` forbids any intermediate below it.
    extension("2.5.29.19", sequence(der(0x01, Uint8Array.from([0xff])), der(0x02, Uint8Array.from([0]))), true),
    extension("2.5.29.15", bitString(Uint8Array.from([0x84]), 2), true), // keyUsage: digitalSignature, keyCertSign
    extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))), // extendedKeyUsage: serverAuth
    extension("2.5.29.17", subjectAltName),
  ));

  const toBeSigned = sequence(
    der(0xa0, der(0x02, Uint8Array.from([2]))), // version: v3
    der(0x02, serial),
    algorithm,
    subject,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", toBeSigned, { key: privateKey, dsaEncoding: "der" });
  const certificate = sequence(toBeSigned, algorithm, bitString(signature));

  const pem = (label: string, bytes: Uint8Array) =>
    `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64").replace(/.{1,64}/g, "$&\n")}-----END ${label}-----\n`;
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certPem: pem("CERTIFICATE", certificate),
    notBefore,
    notAfter,
  };
}
