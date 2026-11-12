/**
 * Quotas and signed direct uploads for a Project's file storage.
 *
 * **Quota.** A storage may hold at most `maxBytes` in all and `maxFileBytes` per file. Every write through the
 * storage routes (a file written, an import, a confirmed upload) is checked against it, and writes take one permit
 * so two of them cannot both pass a check that only one fits under. The quota and the storage's own state live
 * under the reserved prefix `.zelavis/`, which the file routes refuse.
 *
 * **Signed uploads.** A caller allowed to write files asks for an upload: a path, at most how many bytes, an
 * optional content type, and how long the link lives (at most an hour). It gets a URL whose token is an HMAC (key
 * generated once per storage and kept under `.zelavis/`) over the upload's terms, so the terms cannot be changed by
 * whoever holds the link. A browser then sends the bytes there with no credentials: they are refused past the
 * size, with another content type, after expiry, or a second time (the upload is single use). Bytes land in
 * staging, not at the path: an upload is only a file once a caller allowed to write confirms it, which is where an
 * App checks the file is the one its record expects (`sha256`, size, type). Uploads never confirmed are removed by
 * `cleanup` once expired.
 */
import { Effect, Semaphore } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { isString, objectFields, optional, parseJson } from "../core/json-validation.js";
import { ZelavisValidationError } from "./shared.js";
import type { ZelavisFileStorage } from "./storage-types.js";

export const RESERVED_PREFIX = ".zelavis/";
const QUOTA = ".zelavis/quota.json";
const KEY = ".zelavis/upload-key";
const STAGING = ".zelavis/uploads/";
const MAX_LIFETIME_SECONDS = 3600;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

export interface StorageQuota { readonly maxBytes?: number; readonly maxFileBytes?: number }
export interface StorageUsage { readonly bytes: number; readonly files: number }
export interface UploadTerms { readonly id: string; readonly path: string; readonly maxBytes: number; readonly contentType?: string; readonly expiresAt: string }
export interface UploadRecord extends UploadTerms { readonly state: "pending" | "received" | "confirmed"; readonly size?: number; readonly sha256?: string }

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
const sha256Hex = (bytes: Uint8Array) => Effect.map(Effect.promise(() => crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))), (digest) =>
  [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const refuse = (message: string) => new ZelavisValidationError(message);
const termsRecord = objectFields<UploadTerms>({
  id: isString, path: isString, maxBytes: (value): value is number => typeof value === "number", contentType: optional(isString), expiresAt: isString,
});

/** A path a person may write: not reserved, not empty. */
export const checkUserPath = (path: string) => {
  if (path === "" || path.startsWith(RESERVED_PREFIX) || path.startsWith("/")) throw refuse(`"${path}" is not a path files can be written to (the ${RESERVED_PREFIX} prefix is reserved).`);
};

export const storageControls = (storage: ZelavisFileStorage) => {
  const permit = Semaphore.makeUnsafe(1);
  const readJson = (path: string) => Effect.map(integration(() => Promise.resolve(storage.get(path))), (object) =>
    object === undefined ? undefined : parseJson(decoder.decode(object.body), isRecord, path));
  const writeJson = (path: string, value: unknown) => integration(() => Promise.resolve(storage.put({ path, body: encoder.encode(JSON.stringify(value)), contentType: "application/json" })));

  const quota = Effect.map(readJson(QUOTA), (value): StorageQuota => ({
    ...(typeof value?.maxBytes === "number" ? { maxBytes: value.maxBytes } : {}),
    ...(typeof value?.maxFileBytes === "number" ? { maxFileBytes: value.maxFileBytes } : {}),
  }));
  const usage = Effect.map(integration(() => Promise.resolve(storage.list?.() ?? [])), (entries): StorageUsage => {
    const files = entries.filter((entry) => !entry.path.startsWith(RESERVED_PREFIX));
    return { bytes: files.reduce((sum, entry) => sum + (entry.size ?? 0), 0), files: files.length };
  });

  /** Run `write` (of `size` bytes at `path`) only if the quota allows it, under the one permit. */
  const withinQuota = <A, E>(path: string, size: number, write: Effect.Effect<A, E>) => permit.withPermits(1)(Effect.gen(function* () {
    const limits = yield* quota;
    if (limits.maxFileBytes !== undefined && size > limits.maxFileBytes) {
      return yield* Effect.fail(refuse(`A file may be at most ${limits.maxFileBytes} bytes; this one is ${size}.`));
    }
    if (limits.maxBytes !== undefined) {
      const current = yield* usage;
      const replaced = (yield* integration(() => Promise.resolve(storage.list?.(path) ?? []))).find((entry) => entry.path === path)?.size ?? 0;
      if (current.bytes - replaced + size > limits.maxBytes) {
        return yield* Effect.fail(refuse(`This storage may hold ${limits.maxBytes} bytes; it holds ${current.bytes}, and ${size} more do not fit.`));
      }
    }
    return yield* write;
  }));

  const key = permit.withPermits(1)(Effect.gen(function* () {
    const held = yield* integration(() => Promise.resolve(storage.get(KEY)));
    const raw = held?.body ?? crypto.getRandomValues(new Uint8Array(32));
    if (held === undefined) yield* integration(() => Promise.resolve(storage.put({ path: KEY, body: raw, condition: { ifAbsent: true } })));
    return yield* Effect.promise(() => crypto.subtle.importKey("raw", Uint8Array.from(raw), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]));
  }));
  const sign = (terms: UploadTerms) => Effect.gen(function* () {
    const payload = encoder.encode(JSON.stringify(terms));
    const cryptoKey = yield* key;
    const signature = new Uint8Array(yield* Effect.promise(() => crypto.subtle.sign("HMAC", cryptoKey, payload)));
    return `${b64url(payload)}.${b64url(signature)}`;
  });
  const verify = (token: string) => Effect.gen(function* () {
    const [payloadText, signatureText, extra] = token.split(".");
    if (!payloadText || !signatureText || extra !== undefined) return yield* Effect.fail(refuse("This upload link is not valid."));
    const payload = fromB64url(payloadText);
    const ok = yield* Effect.flatMap(key, (cryptoKey) => Effect.promise(() => crypto.subtle.verify("HMAC", cryptoKey, fromB64url(signatureText), payload)));
    if (!ok) return yield* Effect.fail(refuse("This upload link is not valid."));
    // Signed by this storage, so well formed; still read through a validator.
    return parseJson(decoder.decode(payload), termsRecord, "upload terms");
  });
  const recordPath = (id: string) => `${STAGING}${id}.json`;
  const blobPath = (id: string) => `${STAGING}${id}.bin`;

  return {
    quota,
    usage,
    withinQuota,
    setQuota: (input: StorageQuota) => Effect.gen(function* () {
      for (const field of ["maxBytes", "maxFileBytes"] as const) {
        const value = input[field];
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) return yield* Effect.fail(refuse(`${field} is a positive whole number of bytes.`));
      }
      yield* writeJson(QUOTA, { ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }), ...(input.maxFileBytes === undefined ? {} : { maxFileBytes: input.maxFileBytes }) });
      return { quota: yield* quota, usage: yield* usage };
    }),
    /** A signed, single-use upload link's terms and token. */
    createUpload: (input: { readonly path: string; readonly maxBytes: number; readonly contentType?: string; readonly expiresInSeconds?: number }) => Effect.gen(function* () {
      checkUserPath(input.path);
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > MAX_UPLOAD_BYTES) return yield* Effect.fail(refuse(`maxBytes is 1 to ${MAX_UPLOAD_BYTES}.`));
      const lifetime = input.expiresInSeconds ?? 900;
      if (!Number.isSafeInteger(lifetime) || lifetime < 1 || lifetime > MAX_LIFETIME_SECONDS) return yield* Effect.fail(refuse(`expiresInSeconds is 1 to ${MAX_LIFETIME_SECONDS}.`));
      const limits = yield* quota;
      if (limits.maxFileBytes !== undefined && input.maxBytes > limits.maxFileBytes) return yield* Effect.fail(refuse(`A file may be at most ${limits.maxFileBytes} bytes.`));
      const terms: UploadTerms = {
        id: crypto.randomUUID(), path: input.path, maxBytes: input.maxBytes,
        ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
        expiresAt: new Date(Date.now() + lifetime * 1000).toISOString(),
      };
      yield* writeJson(recordPath(terms.id), { ...terms, state: "pending" } satisfies UploadRecord);
      return { ...terms, token: yield* sign(terms) };
    }),
    /** The bytes of a signed upload, received once, into staging. */
    receive: (token: string, body: Uint8Array, contentType: string | undefined) => Effect.gen(function* () {
      const terms = yield* verify(token);
      if (Date.parse(terms.expiresAt) < Date.now()) return yield* Effect.fail(refuse("This upload link has expired."));
      if (body.byteLength > terms.maxBytes) return yield* Effect.fail(refuse(`This upload may be at most ${terms.maxBytes} bytes.`));
      if (terms.contentType !== undefined && contentType?.split(";")[0]?.trim() !== terms.contentType) return yield* Effect.fail(refuse(`This upload must be ${terms.contentType}.`));
      const record = yield* readJson(recordPath(terms.id));
      if (record?.state !== "pending") return yield* Effect.fail(refuse("This upload link has been used."));
      // Claimed before the bytes are written: a second send of the same link is refused even mid-transfer.
      yield* withinQuota(terms.path, body.byteLength, Effect.void);
      const sha256 = yield* sha256Hex(body);
      yield* integration(() => Promise.resolve(storage.put({ path: blobPath(terms.id), body, ...(contentType === undefined ? {} : { contentType }) })));
      yield* writeJson(recordPath(terms.id), { ...terms, state: "received", size: body.byteLength, sha256 } satisfies UploadRecord);
      return { id: terms.id, size: body.byteLength, sha256 };
    }),
    /** Move a received upload to its path, once a caller allowed to write has checked it is the expected file. */
    confirm: (id: string, expect?: { readonly sha256?: string; readonly size?: number }) => Effect.gen(function* () {
      const record = yield* readJson(recordPath(id));
      if (record === undefined) return yield* Effect.fail(refuse(`No upload "${id}".`));
      if (record.state !== "received") return yield* Effect.fail(refuse(`Upload "${id}" is ${String(record.state)}, not received.`));
      if (expect?.sha256 !== undefined && expect.sha256 !== record.sha256) return yield* Effect.fail(refuse(`Upload "${id}" is not the expected file (its SHA-256 differs).`));
      if (expect?.size !== undefined && expect.size !== record.size) return yield* Effect.fail(refuse(`Upload "${id}" is ${String(record.size)} bytes, not ${expect.size}.`));
      const blob = yield* integration(() => Promise.resolve(storage.get(blobPath(id))));
      if (blob === undefined) return yield* Effect.fail(refuse(`Upload "${id}" lost its bytes.`));
      const path = String(record.path);
      yield* withinQuota(path, blob.body.byteLength, integration(() => Promise.resolve(storage.put({
        path, body: blob.body, ...(blob.contentType === undefined ? {} : { contentType: blob.contentType }),
        metadata: { "zelavis-sha256": String(record.sha256), "zelavis-upload": id },
      }))));
      yield* integration(() => Promise.resolve(storage.delete(blobPath(id))));
      yield* writeJson(recordPath(id), { ...record, state: "confirmed" });
      return { id, path, size: Number(record.size), sha256: String(record.sha256) };
    }),
    /** Remove uploads past their expiry that were never confirmed, and the records of confirmed ones. */
    cleanup: Effect.gen(function* () {
      const entries = yield* integration(() => Promise.resolve(storage.list?.(STAGING) ?? []));
      let removed = 0;
      for (const entry of entries.filter((item) => item.path.endsWith(".json"))) {
        const record = yield* readJson(entry.path);
        const expired = record === undefined || Date.parse(String(record.expiresAt)) < Date.now();
        if (record?.state === "confirmed" || (expired && record?.state !== "confirmed")) {
          const id = entry.path.slice(STAGING.length, -".json".length);
          yield* integration(() => Promise.resolve(storage.delete(blobPath(id)))).pipe(Effect.orElseSucceed(() => false));
          yield* integration(() => Promise.resolve(storage.delete(entry.path)));
          if (record?.state !== "confirmed") removed += 1;
        }
      }
      return { removed };
    }),
  };
};

export type StorageControls = ReturnType<typeof storageControls>;
export const runControl = <A>(effect: Effect.Effect<A, unknown>) => present(effect as Effect.Effect<A, never>);
