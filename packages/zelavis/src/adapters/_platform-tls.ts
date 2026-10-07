import { X509Certificate } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { Data, Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import { generateAgentCertificate } from "./_agent-certificate.js";

/**
 * The Platform's own TLS identity for the enrollment listener.
 *
 * A Platform reached by IP address has no public certificate, so a joining machine
 * authenticates it by pinning this certificate's SHA-256 (the same pin `zelavis worker join`
 * takes). The key is created here, kept at 0600 in the Platform's data directory, and never
 * leaves it; the certificate and its fingerprint are public.
 *
 * Authority and bounds: one key pair per data directory. It is reused while the certificate
 * is valid for more than the renewal margin and names every requested address; otherwise a
 * new pair replaces it, written atomically, key first so a crash never leaves a certificate
 * with no key. A key or directory readable by others is refused rather than trusted.
 */

const KEY_FILE = "platform-tls.key";
const CERT_FILE = "platform-tls.crt";
const RENEW_MARGIN_MS = 30 * 24 * 60 * 60_000;

export interface PlatformTlsIdentity {
  readonly keyPem: string;
  readonly certPem: string;
  /** SHA-256 of the certificate, lowercase hex: the value a joining machine pins. */
  readonly fingerprint: string;
}

export const fingerprintOf = (certPem: string): string =>
  new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase();

const covers = (certificate: X509Certificate, names: readonly string[]): boolean =>
  names.every((name) => (isIP(name) === 0 ? certificate.checkHost(name) : certificate.checkIP(name)) !== undefined);

/** A refusal or failure to produce the identity; the message says what to fix. */
export class PlatformTlsError extends Data.TaggedError("PlatformTlsError")<{ readonly message: string; readonly cause?: unknown }> {}

const tlsFailure = (message: string, cause?: unknown) => new PlatformTlsError({ message, ...(cause === undefined ? {} : { cause }) });

const atomicWrite = (path: string, body: string, mode: number) => {
  const temporary = `${path}.${process.pid}.tmp`;
  return integration(() => writeFile(temporary, body, { mode, flag: "w" })).pipe(
    Effect.andThen(integration(() => chmod(temporary, mode))),
    Effect.andThen(integration(() => rename(temporary, path))),
  );
};

export const loadOrCreatePlatformTls = (options: {
  readonly directory: string;
  /** Addresses and hostnames the Platform is reached by. */
  readonly names: readonly string[];
  readonly now?: () => number;
}): Effect.Effect<PlatformTlsIdentity, PlatformTlsError> => Effect.gen(function* () {
  const now = options.now ?? (() => Date.now());
  yield* integration(() => mkdir(options.directory, { recursive: true, mode: 0o700 }));
  const directory = yield* integration(() => lstat(options.directory));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) {
    return yield* tlsFailure("The Platform TLS directory must be a private directory (mode 0700).");
  }
  const keyPath = join(options.directory, KEY_FILE);
  const certPath = join(options.directory, CERT_FILE);

  const existing = yield* Effect.all({
    key: integration(() => readFile(keyPath, "utf8")),
    cert: integration(() => readFile(certPath, "utf8")),
    mode: integration(() => lstat(keyPath)).pipe(Effect.map((stats) => stats.mode)),
  }).pipe(Effect.option);
  if (existing._tag === "Some") {
    const { key, cert, mode } = existing.value;
    if ((mode & 0o077) !== 0) return yield* tlsFailure("The Platform TLS key is readable by others; refusing to use it.");
    const parsed = yield* Effect.try({ try: () => new X509Certificate(cert), catch: (cause) => tlsFailure("The stored Platform certificate is not readable.", cause) });
    if (Date.parse(parsed.validTo) - now() > RENEW_MARGIN_MS && covers(parsed, options.names)) {
      return { keyPem: key, certPem: cert, fingerprint: fingerprintOf(cert) };
    }
  }

  const created = yield* Effect.try({
    try: () => generateAgentCertificate({ names: options.names, commonName: "zelavis-platform", now: now() }),
    catch: (cause) => tlsFailure(cause instanceof Error ? cause.message : "The Platform certificate could not be generated.", cause),
  });
  // Key first, so a crash never leaves a certificate with no key.
  yield* atomicWrite(keyPath, created.keyPem, 0o600);
  yield* atomicWrite(certPath, created.certPem, 0o644);
  return { keyPem: created.keyPem, certPem: created.certPem, fingerprint: fingerprintOf(created.certPem) };
}).pipe(Effect.mapError((error) => error instanceof PlatformTlsError ? error : tlsFailure("The Platform TLS identity could not be stored.", error)));
