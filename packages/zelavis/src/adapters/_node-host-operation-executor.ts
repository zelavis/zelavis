import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  validateHostOperationManifest,
  validateHostOperationRequest,
  ZelavisHostOperationValidationError,
  type ZelavisHostOperationExecutor,
  type ZelavisHostOperationManifest,
  type ZelavisHostOperationRequest,
  type ZelavisHostOperationResult,
} from "../core/deployment/index.js";

export interface NodeHostOperationRegistration {
  readonly manifest: ZelavisHostOperationManifest;
  readonly file: string;
}

export interface NodeHostOperationExecutorOptions {
  readonly rootDirectory: string;
  readonly operations: readonly NodeHostOperationRegistration[];
  readonly authorize: (request: Readonly<ZelavisHostOperationRequest>) => Promise<boolean>;
  readonly requireRootOwnedArtifacts?: boolean;
  readonly maxOutputBytes?: number;
}

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function requestFingerprint(request: ZelavisHostOperationRequest): string {
  return createHash("sha256").update(JSON.stringify({
    operation: request.operation,
    version: request.version,
    artifactDigest: request.artifactDigest,
    arguments: Object.entries(request.arguments).sort(([left], [right]) => left.localeCompare(right)),
    projectId: request.projectId,
  })).digest("hex");
}

export async function createNodeHostOperationExecutor(
  options: NodeHostOperationExecutorOptions,
): Promise<ZelavisHostOperationExecutor> {
  const requestedRoot = resolve(options.rootDirectory);
  const rootStats = await lstat(requestedRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new ZelavisHostOperationValidationError(
      "Host operation root must be a regular directory, not a symbolic link.",
    );
  }
  if ((rootStats.mode & 0o022) !== 0) {
    throw new ZelavisHostOperationValidationError(
      "Host operation root must not be group- or world-writable.",
    );
  }
  if (options.requireRootOwnedArtifacts && rootStats.uid !== 0) {
    throw new ZelavisHostOperationValidationError(
      "Privileged host operation root must be owned by root.",
    );
  }
  const rootDirectory = await realpath(requestedRoot);
  const registrations = new Map<string, {
    manifest: ZelavisHostOperationManifest;
    file: string;
  }>();
  for (const registration of options.operations) {
    const manifest = validateHostOperationManifest(registration.manifest);
    const requestedFile = resolve(rootDirectory, registration.file);
    const relativeRequestedFile = relative(rootDirectory, requestedFile);
    if (
      !relativeRequestedFile ||
      relativeRequestedFile.startsWith("..") ||
      isAbsolute(relativeRequestedFile)
    ) {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact must be a file below the configured operation root.",
      );
    }
    let parent = dirname(requestedFile);
    const parents: string[] = [];
    while (parent !== rootDirectory) {
      parents.push(parent);
      const next = dirname(parent);
      if (next === parent) {
        throw new ZelavisHostOperationValidationError(
          "Host operation artifact parent escaped the configured operation root.",
        );
      }
      parent = next;
    }
    for (const directory of parents.reverse()) {
      const directoryStats = await lstat(directory);
      if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        throw new ZelavisHostOperationValidationError(
          "Host operation artifact parents must be regular directories, not symbolic links.",
        );
      }
      if ((directoryStats.mode & 0o022) !== 0) {
        throw new ZelavisHostOperationValidationError(
          "Host operation artifact parents must not be group- or world-writable.",
        );
      }
      if (options.requireRootOwnedArtifacts && directoryStats.uid !== 0) {
        throw new ZelavisHostOperationValidationError(
          "Privileged host operation artifact parents must be owned by root.",
        );
      }
    }
    const requestedStats = await lstat(requestedFile);
    if (requestedStats.isSymbolicLink()) {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact must not be a symbolic link.",
      );
    }
    const file = await realpath(requestedFile);
    const relativeFile = relative(rootDirectory, file);
    if (!relativeFile || relativeFile.startsWith("..") || isAbsolute(relativeFile)) {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact must be a file below the configured operation root.",
      );
    }
    const stats = await lstat(file);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact must be a regular non-symlink file.",
      );
    }
    if ((stats.mode & 0o100) === 0) {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact must be executable by its owner.",
      );
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact must not be group- or world-writable.",
      );
    }
    if (options.requireRootOwnedArtifacts && stats.uid !== 0) {
      throw new ZelavisHostOperationValidationError(
        "Privileged host operation artifacts must be owned by root.",
      );
    }
    const body = await readFile(file);
    if (digest(body) !== manifest.sha256) {
      throw new ZelavisHostOperationValidationError(
        `Host operation artifact digest does not match "${manifest.id}" ${manifest.version}.`,
      );
    }
    if (registrations.has(manifest.id)) {
      throw new ZelavisHostOperationValidationError(
        `Duplicate host operation registration "${manifest.id}".`,
      );
    }
    registrations.set(manifest.id, { manifest, file });
  }

  const completed = new Map<string, { fingerprint: string; result: ZelavisHostOperationResult }>();
  const active = new Map<string, { fingerprint: string; promise: Promise<ZelavisHostOperationResult> }>();
  const maxOutputBytes = Math.max(1_024, Math.min(options.maxOutputBytes ?? 256 * 1_024, 4 * 1_024 * 1_024));

  return {
    async execute(request) {
      const registration = registrations.get(request.operation);
      if (!registration) {
        throw new ZelavisHostOperationValidationError(
          `Host operation "${request.operation}" is not registered.`,
        );
      }
      validateHostOperationRequest(request, registration.manifest);
      const fingerprint = requestFingerprint(request);
      if (!(await options.authorize(request))) {
        throw new ZelavisHostOperationValidationError(
          "Host operation authority was rejected.",
        );
      }
      const finished = completed.get(request.operationId);
      if (finished) {
        if (finished.fingerprint !== fingerprint) {
          throw new ZelavisHostOperationValidationError(
            "Host operation id was already used for a different request.",
          );
        }
        return finished.result;
      }
      const running = active.get(request.operationId);
      if (running) {
        if (running.fingerprint !== fingerprint) {
          throw new ZelavisHostOperationValidationError(
            "Host operation id is active for a different request.",
          );
        }
        return running.promise;
      }
      const promise = (async (): Promise<ZelavisHostOperationResult> => {
        const body = await readFile(registration.file);
        if (digest(body) !== registration.manifest.sha256) {
          throw new ZelavisHostOperationValidationError(
            "Host operation artifact changed after registration.",
          );
        }
        const startedAt = new Date().toISOString();
        const deadlineMs = Date.parse(request.deadline) - Date.now();
        const args = Object.entries(request.arguments)
          .sort(([left], [right]) => left.localeCompare(right))
          .flatMap(([name, value]) => [`--${name}`, value]);
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun, rejectRun) => {
          const child = spawn(registration.file, args, {
            shell: false,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
            },
          });
          let stdout = Buffer.alloc(0);
          let stderr = Buffer.alloc(0);
          const append = (current: Buffer, chunk: Buffer) =>
            Buffer.concat([current, chunk]).subarray(0, maxOutputBytes);
          child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
          child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
          child.once("error", rejectRun);
          const timer = setTimeout(() => child.kill("SIGKILL"), deadlineMs);
          child.once("close", (code) => {
            clearTimeout(timer);
            resolveRun({
              code: code ?? 1,
              stdout: stdout.toString("utf8"),
              stderr: stderr.toString("utf8"),
            });
          });
        });
        const operationResult: ZelavisHostOperationResult = {
          operationId: request.operationId,
          operation: request.operation,
          version: request.version,
          status: result.code === 0 ? "succeeded" : "failed",
          exitCode: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          startedAt,
          finishedAt: new Date().toISOString(),
        };
        completed.set(request.operationId, { fingerprint, result: operationResult });
        return operationResult;
      })();
      active.set(request.operationId, { fingerprint, promise });
      try {
        return await promise;
      } finally {
        active.delete(request.operationId);
      }
    },
  };
}
