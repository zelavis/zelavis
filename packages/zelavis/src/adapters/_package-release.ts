import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
export const EXACT_INSTALL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export function packageReleaseLocation(version: string, platform: string, architecture: string) {
  if (!EXACT_INSTALL_VERSION.test(version)) throw new Error("Package installation requires an exact version; tags and ranges are refused.");
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(architecture)) throw new Error(`Unsupported installation target: ${platform}-${architecture}.`);
  const name = `zelavis-${version}-${platform}-${architecture}`;
  return { name, metadata: `https://registry.npmjs.org/zelavis/${encodeURIComponent(version)}`, base: `https://github.com/zelavis/zelavis/releases/download/${encodeURIComponent(`zelavis@${version}`)}` };
}

async function response(url: string, fetcher: typeof fetch): Promise<Response> {
  const result = await fetcher(url, { redirect: url.startsWith("https://registry.npmjs.org/") ? "error" : "follow", signal: AbortSignal.timeout(300_000) });
  if (!result.ok) throw new Error(`Release acquisition failed (${result.status}): ${url}. The matching release must be published before it can be installed.`);
  if (result.url && !result.url.startsWith("https://")) throw new Error("Refusing a non-HTTPS release download.");
  return result;
}

async function boundedText(result: Response, limit: number): Promise<string> {
  if (!result.body) throw new Error("Download has no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of result.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error("Release metadata exceeds its size bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function assertReleaseLinksContained(source: string): Promise<void> {
  if (!(await lstat(source)).isDirectory()) throw new Error("Release root must be a directory.");
  const root = await realpath(source);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await realpath(path);
        if (target !== root && !target.startsWith(`${root}/`)) throw new Error("Release link escapes its verified tree.");
      } else if (entry.isDirectory()) await visit(path);
    }
  };
  await visit(source);
}

/** npm identifies the version; the prebuilt release carries the production tree. */
export async function acquirePackageRelease(version: string, options: {
  readonly fetch?: typeof fetch;
  readonly platform?: string;
  readonly architecture?: string;
  readonly temporaryParent?: string;
} = {}): Promise<{ readonly source: string; cleanup(): Promise<void> }> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const location = packageReleaseLocation(version, platform, architecture);
  const fetcher = options.fetch ?? fetch;
  const metadata = JSON.parse(await boundedText(await response(location.metadata, fetcher), 1024 * 1024)) as { name?: unknown; version?: unknown; dist?: { integrity?: unknown } };
  if (metadata.name !== "zelavis" || metadata.version !== version || typeof metadata.dist?.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(metadata.dist.integrity)) throw new Error("Invalid published package metadata.");
  const checksums = await boundedText(await response(`${location.base}/SHA256SUMS`, fetcher), 1024 * 1024);
  const matches = checksums.split("\n").map((line) => line.trim().split(/\s+/u)).filter(([, name]) => name === `${location.name}.tar.gz`);
  if (matches.length !== 1) throw new Error("The release has no unique checksum for this installation target.");
  const expected = matches[0][0];
  const temporary = await mkdtemp(join(options.temporaryParent ?? tmpdir(), "zelavis-package-install-"));
  const cleanup = () => rm(temporary, { recursive: true, force: true });
  try {
    const archive = join(temporary, "release.tar.gz");
    const result = await response(`${location.base}/${location.name}.tar.gz`, fetcher);
    if (!result.body) throw new Error("Release archive has no body.");
    let bytes = 0;
    await pipeline(Readable.fromWeb(result.body as import("node:stream/web").ReadableStream), new Transform({ transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > 512 * 1024 * 1024 ? new Error("Release archive exceeds its size bound.") : null, chunk);
    } }), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
    // This is the same authored checksum implementation staging uses.
    const moduleUrl = new URL("../installation-assets/runtime-assets.mjs", import.meta.url).href;
    const { verifyFileChecksum } = await import(moduleUrl) as { verifyFileChecksum(path: string, expected: string): Promise<void> };
    await verifyFileChecksum(archive, expected);
    const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 32 * 1024 * 1024 });
    for (const member of stdout.trim().split("\n")) {
      if (!(member === location.name || member.startsWith(`${location.name}/`)) || member.split("/").some((part) => part === ".." || part === ".")) throw new Error("Unsafe release archive member.");
    }
    await exec("tar", ["--no-same-owner", "-xzf", archive, "-C", temporary]);
    const source = join(temporary, location.name);
    await assertReleaseLinksContained(source);
    const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
    if (manifest.name !== "zelavis" || manifest.version !== version || manifest.platform !== platform || manifest.architecture !== architecture) throw new Error("Release identity does not match the published package and host.");
    const node = await lstat(join(source, "runtime/node/bin/node"));
    if (!node.isFile()) throw new Error("Release lacks its private Node binary.");
    return { source, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
