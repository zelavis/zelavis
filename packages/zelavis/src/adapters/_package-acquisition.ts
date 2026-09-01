/**
 * Acquiring service packages from remote sources.
 *
 * Fetches a package the trust policy allows, verifies it is byte-for-byte what
 * the registry said it would be, and hands its entries to the same install path
 * an uploaded archive takes. Nothing here decides *whether* a source is
 * allowed — that is `platform/package-sources.ts`, kept separate so the policy
 * can be reasoned about without a network in the picture.
 */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import {
  assertPackageSourceAllowed,
  assertTarballOrigin,
  parsePackageSourceRef,
  resolveGitArchiveUrl,
  ZELAVIS_DEFAULT_NPM_REGISTRY,
  type ZelavisPackageSourceRef,
  type ZelavisServiceSourcePolicy,
} from "../platform/package-sources.js";

/** One file from an acquired package. */
export interface PackageEntry {
  path: string;
  body: Uint8Array;
}

const TAR_BLOCK = 512;
const MAX_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
/** Registry metadata is small; a huge document is a denial-of-service attempt. */
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

function readOctal(bytes: Uint8Array, offset: number, length: number): number {
  let text = "";
  for (let index = offset; index < offset + length; index += 1) {
    const byte = bytes[index];
    if (byte === 0 || byte === 0x20) break;
    text += String.fromCharCode(byte);
  }
  return text ? Number.parseInt(text, 8) : 0;
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  let end = offset;
  while (end < offset + length && bytes[end] !== 0) end += 1;
  return new TextDecoder().decode(bytes.subarray(offset, end));
}

/**
 * Reads a gzipped tar archive as npm publishes it.
 *
 * Only regular files are kept. A tar can also carry symlinks, hard links,
 * devices, and directory entries; a symlink pointing outside the package would
 * turn extraction into an arbitrary-write primitive, so link types are refused
 * outright rather than resolved.
 */
export function readTarGzEntries(bytes: Uint8Array): PackageEntry[] {
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(
      gunzipSync(bytes, { maxOutputLength: MAX_TOTAL_BYTES }),
    );
  } catch (cause) {
    throw new Error("Package archive is not a readable gzip stream.", { cause });
  }

  const entries: PackageEntry[] = [];
  let offset = 0;
  let total = 0;

  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);

    // Two consecutive zero blocks end the archive; one is enough to stop.
    if (header.every((byte) => byte === 0)) break;

    const name = readString(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const prefix = readString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;

    offset += TAR_BLOCK;

    if (size > MAX_ENTRY_BYTES) {
      throw new Error(
        `Package entry "${path}" exceeds the ${MAX_ENTRY_BYTES} byte limit.`,
      );
    }

    const body = tar.subarray(offset, offset + size);
    // Entry bodies are padded to a block boundary.
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    // "0"/"\0" are regular files; "5" is a directory, which carries no content.
    // Everything else — symlinks (2), hard links (1), devices, fifos — is
    // refused rather than interpreted.
    if (typeFlag === "5") continue;
    if (typeFlag === "x" || typeFlag === "g" || typeFlag === "L") {
      // pax/GNU extended headers describe the *next* entry. Rather than
      // partially implement them and risk disagreeing with the writer about
      // which name applies, refuse archives that use them.
      throw new Error(
        "Package archive uses extended tar headers, which are not supported.",
      );
    }
    if (typeFlag !== "0" && typeFlag !== "\0") {
      throw new Error(
        `Package archive entry "${path}" is not a regular file.`,
      );
    }

    total += size;
    if (total > MAX_TOTAL_BYTES) {
      throw new Error(
        `Package archive exceeds the ${MAX_TOTAL_BYTES} byte limit.`,
      );
    }
    if (entries.length >= MAX_ENTRIES) {
      throw new Error(`Package archive exceeds ${MAX_ENTRIES} entries.`);
    }

    entries.push({ path, body: new Uint8Array(body) });
  }

  return entries;
}

/**
 * Strips the single top-level directory a source archive is wrapped in.
 *
 * A forge names it after the repository and commit rather than `package`, so
 * the exact name cannot be asserted. What can be asserted is that there is
 * exactly one: an archive with entries at more than one root, or at the root
 * itself, is not the shape a source archive takes and is not unpacked.
 */
export function stripSingleRootDirectory(
  entries: readonly PackageEntry[],
): PackageEntry[] {
  const roots = new Set<string>();
  for (const entry of entries) {
    const normalized = entry.path.replace(/^\.\//, "");
    const separator = normalized.indexOf("/");
    if (separator <= 0) {
      throw new Error(
        `Package archive entry "${entry.path}" is not inside a root directory.`,
      );
    }
    roots.add(normalized.slice(0, separator));
  }

  if (roots.size !== 1) {
    throw new Error(
      `Package archive has ${roots.size} root directories; expected exactly one.`,
    );
  }

  const [root] = roots;
  return entries.map((entry) => ({
    path: entry.path.replace(/^\.\//, "").slice(root.length + 1),
    body: entry.body,
  }));
}

/**
 * Strips npm's leading `package/` directory.
 *
 * An entry outside that directory is not something to quietly relocate: npm
 * puts everything under it, so anything else means the archive is not shaped
 * the way it claims.
 */
export function stripPackagePrefix(
  entries: readonly PackageEntry[],
): PackageEntry[] {
  return entries.map((entry) => {
    const normalized = entry.path.replace(/^\.\//, "");
    if (!normalized.startsWith("package/")) {
      throw new Error(
        `Package archive entry "${entry.path}" is outside the package root.`,
      );
    }
    return { path: normalized.slice("package/".length), body: entry.body };
  });
}

/**
 * Verifies a Subresource Integrity string against the bytes actually received.
 *
 * This is the check that makes acquisition safe: the policy says where we may
 * fetch from, and this says we got what that source committed to. `sha1` is
 * accepted by the SRI grammar but not here — npm's legacy `dist.shasum` is
 * sha1, and a collision-prone digest is not a commitment.
 */
export function verifyIntegrity(body: Uint8Array, integrity: string): void {
  const candidates = integrity.trim().split(/\s+/).filter(Boolean);
  if (candidates.length === 0) {
    throw new Error("Package metadata did not include an integrity digest.");
  }

  for (const candidate of candidates) {
    const separator = candidate.indexOf("-");
    const algorithm = separator > 0 ? candidate.slice(0, separator) : "";
    const expected = separator > 0 ? candidate.slice(separator + 1) : "";

    if (algorithm !== "sha256" && algorithm !== "sha384" && algorithm !== "sha512") {
      continue;
    }

    const actual = createHash(algorithm).update(body).digest("base64");
    if (actual === expected) return;

    throw new Error(
      `Package integrity check failed: ${algorithm} digest did not match the value the registry published.`,
    );
  }

  throw new Error(
    "Package metadata carried no integrity digest this Platform will accept. sha512 is expected; sha1 is not accepted.",
  );
}

export interface AcquirePackageOptions {
  /** Which sources this installation trusts. Absent means acquire nothing. */
  readonly policy?: ZelavisServiceSourcePolicy;
  /** Registry used when a reference does not name one. */
  readonly defaultRegistry?: string;
  /** Injected for tests; defaults to the global fetch. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface AcquiredPackage {
  readonly entries: readonly PackageEntry[];
  /** What was actually installed, with any dist-tag resolved. */
  readonly resolved: string;
  /** The integrity digest that was verified. */
  readonly integrity: string;
}

async function readCapped(
  response: Response,
  limit: number,
  label: string,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    throw new Error(`${label} exceeds the ${limit} byte limit.`);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  // Content-Length is a claim, not a guarantee; check what arrived.
  if (body.byteLength > limit) {
    throw new Error(`${label} exceeds the ${limit} byte limit.`);
  }
  return body;
}

interface NpmVersionMetadata {
  dist?: { tarball?: unknown; integrity?: unknown };
}

/**
 * Acquires a package from a remote source.
 *
 * Order matters: the policy is checked before anything is fetched, the tarball
 * URL the registry hands back is checked against that same policy before it is
 * followed, and the bytes are verified before they are returned. Any one of
 * those alone leaves a gap.
 */
export async function acquirePackage(
  reference: string,
  options: AcquirePackageOptions = {},
): Promise<AcquiredPackage> {
  const ref = parsePackageSourceRef(reference, {
    defaultRegistry: options.defaultRegistry ?? ZELAVIS_DEFAULT_NPM_REGISTRY,
  });

  assertPackageSourceAllowed(ref, options.policy);

  const doFetch = options.fetch ?? globalThis.fetch;

  if (ref.kind === "https") {
    // No registry vouches for a bare URL, so there is no digest to verify
    // against. It is allowed only for hosts the operator listed explicitly,
    // and the reference records the hash of what was actually installed.
    const response = await doFetch(ref.url, { redirect: "error" });
    if (!response.ok) {
      throw new Error(
        `Failed to download package from ${ref.url}: ${response.status}.`,
      );
    }

    const body = await readCapped(response, MAX_ARCHIVE_BYTES, "Package archive");
    return {
      entries: stripPackagePrefix(readTarGzEntries(body)),
      resolved: ref.url,
      integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
    };
  }

  if (ref.kind === "git") {
    return acquireFromGit(ref, options.policy, doFetch);
  }

  return acquireFromNpm(ref, doFetch);
}

/**
 * Acquires a commit's source archive from a Git forge.
 *
 * There is no digest to verify against, and that is a real difference from npm
 * rather than an oversight: a forge builds its archives on demand, so the bytes
 * are not stable even for the same commit. What holds instead is that the
 * operator listed the forge and the reference pins an immutable commit. The
 * digest of what actually arrived is recorded so the install is still
 * content-addressed and reproducible after the fact.
 */
async function acquireFromGit(
  ref: Extract<ZelavisPackageSourceRef, { kind: "git" }>,
  policy: ZelavisServiceSourcePolicy | undefined,
  doFetch: typeof globalThis.fetch,
): Promise<AcquiredPackage> {
  const url = resolveGitArchiveUrl(ref, policy);

  // Forges redirect archive downloads to storage hosts, so this cannot be
  // `redirect: "error"` the way the others are. Each hop is bounded and the
  // final response is size-capped; the trust still rests on the pinned commit,
  // which a redirect cannot change.
  const response = await doFetch(url.toString());
  if (!response.ok) {
    throw new Error(
      `Failed to download ${ref.repository}@${ref.commit.slice(0, 12)} from ${ref.host}: ${response.status}.`,
    );
  }

  const body = await readCapped(response, MAX_ARCHIVE_BYTES, "Package archive");

  return {
    entries: stripSingleRootDirectory(readTarGzEntries(body)),
    resolved: `git+https://${ref.host}/${ref.repository}#${ref.commit}`,
    integrity: `sha512-${createHash("sha512").update(body).digest("base64")}`,
  };
}

async function acquireFromNpm(
  ref: Extract<ZelavisPackageSourceRef, { kind: "npm" }>,
  doFetch: typeof globalThis.fetch,
): Promise<AcquiredPackage> {
  // The package name goes in a URL path. Encoding it keeps a name that somehow
  // passed validation from reaching a different endpoint than intended; the
  // scope separator stays literal because that is how registries address it.
  const encodedName = ref.name
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  const metadataUrl = `${ref.registry}/${encodedName}/${encodeURIComponent(ref.version)}`;

  const metadataResponse = await doFetch(metadataUrl, {
    headers: { accept: "application/json" },
    redirect: "error",
  });

  if (!metadataResponse.ok) {
    throw new Error(
      `Registry ${ref.registry} has no ${ref.name}@${ref.version} (${metadataResponse.status}).`,
    );
  }

  const raw = await readCapped(
    metadataResponse,
    MAX_METADATA_BYTES,
    "Registry metadata",
  );

  let metadata: NpmVersionMetadata & { version?: unknown };
  try {
    metadata = JSON.parse(new TextDecoder().decode(raw));
  } catch (cause) {
    throw new Error("Registry metadata is not valid JSON.", { cause });
  }

  const tarball = metadata.dist?.tarball;
  const integrity = metadata.dist?.integrity;

  if (typeof tarball !== "string" || !tarball) {
    throw new Error(
      `Registry metadata for ${ref.name}@${ref.version} has no tarball URL.`,
    );
  }
  if (typeof integrity !== "string" || !integrity) {
    throw new Error(
      `Registry metadata for ${ref.name}@${ref.version} has no integrity digest, so what it serves cannot be verified.`,
    );
  }

  const tarballUrl = assertTarballOrigin(tarball, ref.registry);

  const archiveResponse = await doFetch(tarballUrl.toString(), {
    redirect: "error",
  });
  if (!archiveResponse.ok) {
    throw new Error(
      `Failed to download ${ref.name}@${ref.version}: ${archiveResponse.status}.`,
    );
  }

  const body = await readCapped(
    archiveResponse,
    MAX_ARCHIVE_BYTES,
    "Package archive",
  );
  verifyIntegrity(body, integrity);

  const resolvedVersion =
    typeof metadata.version === "string" ? metadata.version : ref.version;

  return {
    entries: stripPackagePrefix(readTarGzEntries(body)),
    // A dist-tag is recorded as the version it resolved to, so what was
    // installed stays legible after the tag moves.
    resolved: `npm:${ref.name}@${resolvedVersion}`,
    integrity,
  };
}
