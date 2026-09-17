/**
 * Host operations inside the supervised Agent process.
 *
 * Assembles the pieces that were only libraries until now: the operator's
 * release trust store, the installed signed operations, the executor, the
 * Agent's own durable journal, and the authority check that binds every run to
 * a short-lived, audience-bound, request-bound signed envelope. The Platform
 * reaches it only through the Agent socket; there is still no HTTP route.
 */
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createAgentNonceTracker,
  verifyAgentAuthority,
  type ZelavisAgentOperationManager,
  type ZelavisAgentOperationSummary,
} from "../core/agent/index.js";
import {
  ZelavisHostOperationValidationError,
  type ZelavisHostOperationManifest,
  type ZelavisHostOperationRequest,
  type ZelavisHostOperationTrustStore,
} from "../core/deployment/index.js";
import { createAgentOperationManager } from "../agent/operation-journal.js";
import {
  createNodeHostOperationExecutor,
  loadInstalledHostOperations,
  type NodeHostOperationExecutorOptions,
} from "./_node-host-operation-executor.js";
import { createLocalSqliteSystemStore } from "./_sqlite-system-store.js";

const JOURNAL_FILE = "operations.sqlite";
const MAX_TRUST_FILE_BYTES = 64 * 1024;

export interface AgentHostOperationServiceOptions {
  /** Agent-private directory holding the operation journal. Created 0700. */
  readonly directory: string;
  /** Installed operations: `<root>/<id>/<version>/{manifest.json, artifact}`. */
  readonly operationsRoot: string;
  /** Operator trust store JSON (`ZelavisHostOperationTrustStore`). */
  readonly trustFile: string;
  /**
   * Platform authority keys (same trust-store format) whose signed envelopes
   * this Agent accepts. The Platform writes its public key file; an Agent on
   * another host is given a copy. Read for every authorization; while it is
   * missing or invalid, every request is refused.
   */
  readonly platformAuthorityFile: string;
  /**
   * Require the trust file, operation tree and interpreters to be root-owned.
   * Production installs set this; a development Agent run by a user cannot.
   */
  readonly requireRootOwned?: boolean;
  readonly supervision?: NodeHostOperationExecutorOptions["supervision"];
  readonly stagingDirectory?: string;
  readonly concurrency?: number;
}

export interface AgentHostOperationCatalog {
  readonly agentId: string;
  /** Verified manifests of the installed operations. */
  readonly operations: readonly ZelavisHostOperationManifest[];
}

export interface AgentHostOperationService {
  readonly agentId: string;
  /** Operation ids and versions accepted from the installed tree. */
  readonly registered: readonly string[];
  catalog(): AgentHostOperationCatalog;
  submit(request: ZelavisHostOperationRequest): Promise<ZelavisAgentOperationSummary>;
  get(operationId: string): Promise<ZelavisAgentOperationSummary | undefined>;
  close(): Promise<void>;
}

/**
 * Reads the trust store the executor verifies signatures against.
 *
 * Whoever can edit this file can make the Agent run anything they sign, so it
 * gets the same treatment as an artifact: a regular file, never a symlink,
 * not group- or world-writable, root-owned when required, bounded, and
 * structurally valid. Keys are not trusted merely for parsing.
 */
export async function readHostOperationTrustStore(
  path: string,
  options: { readonly requireRootOwned?: boolean } = {},
): Promise<ZelavisHostOperationTrustStore> {
  const stats = await lstat(path).catch(() => undefined);
  if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} must be a regular file.`,
    );
  }
  if ((stats.mode & 0o022) !== 0) {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} must not be group- or world-writable.`,
    );
  }
  if (options.requireRootOwned && stats.uid !== 0) {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} must be owned by root.`,
    );
  }
  if (stats.size > MAX_TRUST_FILE_BYTES) {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} exceeds ${MAX_TRUST_FILE_BYTES} bytes.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} is not valid JSON.`,
    );
  }
  const value = parsed as Record<string, unknown>;
  const validTime = (time: unknown) =>
    typeof time === "string" && Number.isFinite(Date.parse(time));
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "keys" && key !== "revokedKeyIds") ||
    !Array.isArray(value.keys) ||
    value.keys.length > 64 ||
    value.keys.some((key: unknown) => {
      const entry = key as Record<string, unknown>;
      return !entry ||
        typeof entry !== "object" ||
        Object.keys(entry).some((field) =>
          !["keyId", "publicKey", "notBefore", "notAfter"].includes(field)) ||
        typeof entry.keyId !== "string" ||
        typeof entry.publicKey !== "string" ||
        !validTime(entry.notBefore) ||
        !validTime(entry.notAfter) ||
        Date.parse(entry.notBefore as string) >= Date.parse(entry.notAfter as string);
    }) ||
    (value.revokedKeyIds !== undefined &&
      (!Array.isArray(value.revokedKeyIds) ||
        value.revokedKeyIds.some((keyId: unknown) => typeof keyId !== "string")))
  ) {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} has an invalid structure.`,
    );
  }
  const keyIds = (value.keys as { keyId: string }[]).map((key) => key.keyId);
  if (new Set(keyIds).size !== keyIds.length) {
    throw new ZelavisHostOperationValidationError(
      `Host operation trust store ${path} lists a key id more than once.`,
    );
  }
  return Object.freeze({
    keys: Object.freeze((value.keys as ZelavisHostOperationTrustStore["keys"]).map((key) =>
      Object.freeze({ ...key }))),
    ...(value.revokedKeyIds
      ? { revokedKeyIds: Object.freeze([...(value.revokedKeyIds as string[])]) }
      : {}),
  });
}

export async function createAgentHostOperationService(
  options: AgentHostOperationServiceOptions,
): Promise<AgentHostOperationService> {
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const trust = await readHostOperationTrustStore(options.trustFile, {
    requireRootOwned: options.requireRootOwned === true,
  });
  const operations = await loadInstalledHostOperations(resolve(options.operationsRoot));
  const consumeNonce = createAgentNonceTracker();
  // The journal resolves the durable Agent identity; the executor's authority
  // check reads it once the journal exists, before any operation can run.
  let agentId: string | undefined;
  const executor = await createNodeHostOperationExecutor({
    rootDirectory: options.operationsRoot,
    operations,
    trust,
    requireRootOwnedArtifacts: options.requireRootOwned === true,
    ...(options.stagingDirectory ? { stagingDirectory: options.stagingDirectory } : {}),
    ...(options.supervision ? { supervision: options.supervision } : {}),
    authorize: async (request) => {
      if (!agentId) return false;
      // Read per authorization: a rotated Platform key is honoured without an
      // Agent restart, and a missing or invalid file authorizes nothing.
      const platformAuthority = await readHostOperationTrustStore(options.platformAuthorityFile)
        .catch(() => undefined);
      if (!platformAuthority) return false;
      const claims = await verifyAgentAuthority(platformAuthority, request.authority, request, {
        audienceAgentId: agentId,
        consumeNonce,
      });
      return claims !== undefined;
    },
  });
  const store = createLocalSqliteSystemStore({ filename: join(directory, JOURNAL_FILE) });
  let manager: ZelavisAgentOperationManager;
  try {
    manager = await createAgentOperationManager({
      store,
      executor,
      ...(options.concurrency ? { concurrency: options.concurrency } : {}),
    });
  } catch (error) {
    await store.close?.();
    throw error;
  }
  agentId = manager.identity.id;
  // Operations queued before a restart, or whose lease lapsed with a crashed
  // Agent, are picked up now. Not awaited: readiness does not wait on them.
  void manager.reconcile().catch(() => undefined);

  return {
    agentId,
    registered: Object.freeze(
      operations.map((operation) =>
        `${operation.signed.manifest.id}@${operation.signed.manifest.version}`),
    ),
    catalog: () => ({
      agentId: agentId!,
      operations: Object.freeze(operations.map((operation) => operation.signed.manifest)),
    }),
    submit: (request) => manager.submit(request),
    get: (operationId) => manager.get(operationId),
    async close() {
      await manager.close();
      await store.close?.();
    },
  };
}
