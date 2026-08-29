import { mkdir, open, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createArtifactDigest,
  type ArtifactStore,
  type ZelavisArtifactDigest,
  type ZelavisArtifactStoreObject,
} from "../core/artifact/index.js";

export interface NodeFileArtifactStoreOptions {
  readonly directory: string;
}

interface StoredArtifactMetadata {
  readonly contentType?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

function digestHex(digest: ZelavisArtifactDigest): string {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  if (!match) throw new TypeError("ArtifactStore digest must be a lowercase sha256 digest.");
  return match[1];
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT",
  );
}

function isExisting(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST",
  );
}

async function writeOnce(path: string, body: Uint8Array | string): Promise<boolean> {
  let file;
  try {
    file = await open(path, "wx", 0o600);
    await file.writeFile(body);
    return true;
  } catch (error) {
    if (isExisting(error)) return false;
    throw error;
  } finally {
    await file?.close();
  }
}

/** Persistent, content-addressed ArtifactStore for local Node Agents. */
export function createNodeFileArtifactStore(
  options: NodeFileArtifactStoreOptions,
): ArtifactStore {
  if (!options.directory?.trim()) {
    throw new TypeError("A Node ArtifactStore directory is required.");
  }
  const root = resolve(options.directory);

  function paths(digest: ZelavisArtifactDigest) {
    const hex = digestHex(digest);
    const directory = join(root, "sha256", hex.slice(0, 2));
    return {
      directory,
      body: join(directory, `${hex}.artifact`),
      metadata: join(directory, `${hex}.json`),
    };
  }

  async function get(digest: ZelavisArtifactDigest): Promise<ZelavisArtifactStoreObject | undefined> {
    const target = paths(digest);
    let body: Uint8Array;
    try {
      body = new Uint8Array(await readFile(target.body));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }

    const actualDigest = await createArtifactDigest(body);
    if (actualDigest !== digest) {
      throw new Error(
        `ArtifactStore object ${digest} is corrupt: content hashes to ${actualDigest}.`,
      );
    }

    let stored: StoredArtifactMetadata = {};
    try {
      stored = JSON.parse(await readFile(target.metadata, "utf8")) as StoredArtifactMetadata;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    return {
      digest,
      body,
      contentType: stored.contentType,
      metadata: stored.metadata ? { ...stored.metadata } : undefined,
    };
  }

  return {
    async has(digest) {
      return (await get(digest)) !== undefined;
    },
    get,
    async put(input) {
      const target = paths(input.digest);
      const actualDigest = await createArtifactDigest(input.body);
      if (actualDigest !== input.digest) {
        throw new TypeError(
          `ArtifactStore content digest mismatch: expected ${input.digest}, received ${actualDigest}.`,
        );
      }

      await mkdir(target.directory, { recursive: true });
      const created = await writeOnce(target.body, input.body);
      if (created) {
        await writeOnce(
          target.metadata,
          JSON.stringify({
            ...(input.contentType ? { contentType: input.contentType } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          } satisfies StoredArtifactMetadata),
        );
      }

      const stored = await get(input.digest);
      if (!stored) throw new Error(`ArtifactStore failed to persist ${input.digest}.`);
      return stored;
    },
  };
}
