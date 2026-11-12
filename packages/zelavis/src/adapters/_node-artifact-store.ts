import { integrationValue, unwrapIntegrationResult, presentProtocol, present, unwrapFailure } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { parseJson, objectFields, isString, optional, recordOf } from "../core/json-validation.js";
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

function writeOnce(path: string, body: Uint8Array | string): Promise<boolean> {
  return present(Effect.acquireUseRelease(
    integrationValue(open(path, "wx", 0o600)).pipe(
      Effect.map((file) => ({ file })),
      Effect.catch((failure) => isExisting(unwrapFailure(failure)) ? Effect.succeed(undefined) : Effect.fail(failure)),
    ),
    (opened) => opened
      ? integrationValue(opened.file.writeFile(body)).pipe(Effect.as(true))
      : Effect.succeed(false),
    (opened) => opened ? integrationValue(opened.file.close()).pipe(Effect.orDie) : Effect.void,
  ));
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

  function get(digest: ZelavisArtifactDigest): Promise<ZelavisArtifactStoreObject | undefined> { return presentProtocol(Effect.gen(function* () {
    const target = paths(digest);
    let body: Uint8Array;
    try {
      body = new Uint8Array(unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(target.body)))));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }

    const actualDigest = (yield* integrationValue(createArtifactDigest(body)));
    if (actualDigest !== digest) {
      throw new Error(
        `ArtifactStore object ${digest} is corrupt: content hashes to ${actualDigest}.`,
      );
    }

    let stored: StoredArtifactMetadata = {};
    try {
      stored = parseJson(unwrapIntegrationResult(yield* Effect.result(integrationValue(readFile(target.metadata, "utf8")))), metadataRecord);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    return {
      digest,
      body,
      contentType: stored.contentType,
      metadata: stored.metadata ? { ...stored.metadata } : undefined,
    };
  }).pipe(Effect.withSpan("createNodeFileArtifactStore/get"))); }

  return {
    has(digest) {
    return present(Effect.gen(function* () {
      return ((yield* integrationValue(get(digest)))) !== undefined;
    }));
  },
    get,
    put(input) {
    return present(Effect.gen(function* () {
      const target = paths(input.digest);
      const actualDigest = (yield* integrationValue(createArtifactDigest(input.body)));
      if (actualDigest !== input.digest) {
        throw new TypeError(
          `ArtifactStore content digest mismatch: expected ${input.digest}, received ${actualDigest}.`,
        );
      }

      (yield* integrationValue(mkdir(target.directory, { recursive: true })));
      const created = (yield* integrationValue(writeOnce(target.body, input.body)));
      if (created) {
        (yield* integrationValue(writeOnce(
          target.metadata,
          JSON.stringify({
            ...(input.contentType ? { contentType: input.contentType } : {}),
            ...(input.metadata ? { metadata: input.metadata } : {}),
          } satisfies StoredArtifactMetadata),
        )));
      }

      const stored = (yield* integrationValue(get(input.digest)));
      if (!stored) throw new Error(`ArtifactStore failed to persist ${input.digest}.`);
      return stored;
    }));
  },
  };
}

const metadataRecord = objectFields<StoredArtifactMetadata>({ contentType: optional(isString), metadata: optional(recordOf(isString)) });
