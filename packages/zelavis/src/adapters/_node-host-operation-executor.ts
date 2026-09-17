import { spawn } from "node:child_process";
import { constants as fsConstants, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  validateHostOperationRequest,
  verifySignedHostOperationManifest,
  ZelavisHostOperationValidationError,
  type ZelavisHostOperationExecutor,
  type ZelavisHostOperationManifest,
  type ZelavisHostOperationRequest,
  type ZelavisHostOperationResult,
  type ZelavisHostOperationTrustStore,
  type ZelavisSignedHostOperationManifest,
} from "../core/deployment/index.js";
import {
  createCgroupV2OperationSupervisor,
  type CgroupOperationLimits,
  type CgroupOperationScope,
} from "./_linux-cgroup-supervisor.js";

export interface NodeHostOperationRegistration {
  /** The release-signed manifest; verified against `trust` before anything else. */
  readonly signed: ZelavisSignedHostOperationManifest;
  /** Artifact path relative to the operation root. */
  readonly file: string;
}

/** Installed layout: `<root>/<id>/<version>/manifest.json` beside `artifact`. */
export const HOST_OPERATION_MANIFEST_FILE = "manifest.json";
export const HOST_OPERATION_ARTIFACT_FILE = "artifact";

export interface NodeHostOperationExecutorOptions {
  readonly rootDirectory: string;
  readonly operations: readonly NodeHostOperationRegistration[];
  /** Release keys the operator trusts. Unsigned or untrusted manifests are refused. */
  readonly trust: ZelavisHostOperationTrustStore;
  readonly authorize: (request: Readonly<ZelavisHostOperationRequest>) => Promise<boolean>;
  readonly requireRootOwnedArtifacts?: boolean;
  readonly maxOutputBytes?: number;
  /**
   * Directory for the private per-execution artifact copies. Must not be
   * group- or world-writable and must allow execution (not `noexec`).
   * Defaults to the OS temporary directory.
   */
  readonly stagingDirectory?: string;
  /**
   * How an operation's processes are contained. `process-group` (default) is
   * portable but a descendant starting a new session escapes it. `cgroup-v2`
   * contains every descendant and reclaims leftovers from a crashed Agent;
   * it is Linux-only and refuses to start rather than falling back.
   */
  readonly supervision?:
    | { readonly kind: "process-group" }
    | {
        readonly kind: "cgroup-v2";
        readonly root: string;
        readonly limits?: CgroupOperationLimits;
      };
}

/** Filesystem identity recorded at registration and required at execution. */
interface ArtifactIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

function identityOf(stats: Stats): ArtifactIdentity {
  return { dev: stats.dev, ino: stats.ino, uid: stats.uid };
}

function sameIdentity(left: ArtifactIdentity, right: ArtifactIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

interface ProvenPath {
  readonly path: string;
  readonly identity: ArtifactIdentity;
  readonly directory: boolean;
}

/**
 * Proves an interpreter and every directory above it: resolved (no symlink
 * left to swap), not group/world-writable, root-owned when required. Returns
 * the identities to re-prove at execution. Shared libraries it loads are not
 * covered.
 */
async function proveInterpreter(
  path: string,
  requireRootOwned: boolean,
): Promise<{ readonly path: string; readonly chain: readonly ProvenPath[] }> {
  const resolved = await realpath(path).catch(() => {
    throw new ZelavisHostOperationValidationError(
      `Host operation interpreter "${path}" does not exist.`,
    );
  });
  const ancestors: string[] = [];
  for (let current = dirname(resolved); ; current = dirname(current)) {
    ancestors.unshift(current);
    if (dirname(current) === current) break;
  }
  const chain: ProvenPath[] = [];
  for (const entry of [...ancestors, resolved]) {
    const stats = await lstat(entry);
    const directory = entry !== resolved;
    if (
      stats.isSymbolicLink() ||
      (directory ? !stats.isDirectory() : !stats.isFile() || (stats.mode & 0o111) === 0) ||
      (stats.mode & 0o022) !== 0 ||
      (requireRootOwned && stats.uid !== 0)
    ) {
      throw new ZelavisHostOperationValidationError(
        `Host operation interpreter "${path}" is not an immutable ${requireRootOwned ? "root-owned " : ""}executable path.`,
      );
    }
    chain.push({ path: entry, identity: identityOf(stats), directory });
  }
  return { path: resolved, chain };
}

/**
 * Reads installed operations from `<root>/<id>/<version>/`. Directory names
 * must match the manifest they hold; the signature is verified by the
 * executor, not here.
 */
export async function loadInstalledHostOperations(
  rootDirectory: string,
): Promise<readonly NodeHostOperationRegistration[]> {
  const registrations: NodeHostOperationRegistration[] = [];
  for (const id of (await readdir(rootDirectory, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
    for (const version of (await readdir(join(rootDirectory, id.name), { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const relativeDirectory = join(id.name, version.name);
      let signed: ZelavisSignedHostOperationManifest;
      try {
        signed = JSON.parse(
          await readFile(join(rootDirectory, relativeDirectory, HOST_OPERATION_MANIFEST_FILE), "utf8"),
        ) as ZelavisSignedHostOperationManifest;
      } catch {
        throw new ZelavisHostOperationValidationError(
          `Installed host operation "${relativeDirectory}" has no readable ${HOST_OPERATION_MANIFEST_FILE}.`,
        );
      }
      if (signed?.manifest?.id !== id.name || signed.manifest.version !== version.name) {
        throw new ZelavisHostOperationValidationError(
          `Installed host operation "${relativeDirectory}" does not match its manifest identity.`,
        );
      }
      registrations.push({ signed, file: join(relativeDirectory, HOST_OPERATION_ARTIFACT_FILE) });
    }
  }
  return registrations;
}

function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try {
    // A negative pid addresses the whole process group the child leads.
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** How long output may keep draining after the operation's leader is gone. */
const OUTPUT_DRAIN_GRACE_MS = 250;

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
  const rootIdentity = identityOf(await lstat(rootDirectory));
  const registrations = new Map<string, {
    manifest: ZelavisHostOperationManifest;
    file: string;
    parents: readonly { path: string; identity: ArtifactIdentity }[];
    identity: ArtifactIdentity;
    interpreter?: { readonly path: string; readonly chain: readonly ProvenPath[] };
  }>();
  const requestedStaging = resolve(options.stagingDirectory ?? tmpdir());
  const stagingStats = await lstat(requestedStaging);
  if (!stagingStats.isDirectory() || stagingStats.isSymbolicLink()) {
    throw new ZelavisHostOperationValidationError(
      "Host operation staging directory must be a regular directory, not a symbolic link.",
    );
  }
  if (options.stagingDirectory && (stagingStats.mode & 0o022) !== 0) {
    throw new ZelavisHostOperationValidationError(
      "Host operation staging directory must not be group- or world-writable.",
    );
  }
  for (const registration of options.operations) {
    const manifest = await verifySignedHostOperationManifest(registration.signed, options.trust);
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
    const parentIdentities: { path: string; identity: ArtifactIdentity }[] = [
      { path: rootDirectory, identity: rootIdentity },
    ];
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
      parentIdentities.push({ path: directory, identity: identityOf(directoryStats) });
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
    // A shebang would let the host pick the interpreter by a path outside
    // the signature; a script must name it in the signed manifest instead.
    if (!manifest.interpreter && body[0] === 0x23 && body[1] === 0x21) {
      throw new ZelavisHostOperationValidationError(
        `Host operation "${manifest.id}" is a script; its manifest must declare an interpreter.`,
      );
    }
    const interpreter = manifest.interpreter
      ? await proveInterpreter(manifest.interpreter, options.requireRootOwnedArtifacts === true)
      : undefined;
    if (registrations.has(manifest.id)) {
      throw new ZelavisHostOperationValidationError(
        `Duplicate host operation registration "${manifest.id}".`,
      );
    }
    registrations.set(manifest.id, {
      manifest,
      file,
      parents: parentIdentities,
      identity: identityOf(stats),
      ...(interpreter ? { interpreter } : {}),
    });
  }

  /**
   * Re-proves the registered artifact at execution time and returns its bytes.
   *
   * Every parent and the file must still be the same inode with the same owner
   * and safe modes: a rename or replacement since registration is refused even
   * when the new file has the right digest. The bytes are read through a
   * no-follow handle whose identity is checked, so the digest describes the
   * file that was proven rather than whatever the path names a moment later.
   */
  async function readVerifiedArtifact(
    registration: NonNullable<ReturnType<typeof registrations.get>>,
  ): Promise<Buffer> {
    const unsafe = (stats: Stats, expected: ArtifactIdentity) =>
      stats.isSymbolicLink() ||
      !sameIdentity(identityOf(stats), expected) ||
      (stats.mode & 0o022) !== 0 ||
      (options.requireRootOwnedArtifacts === true && stats.uid !== 0);
    for (const parent of registration.parents) {
      const stats = await lstat(parent.path).catch(() => undefined);
      if (!stats || !stats.isDirectory() || unsafe(stats, parent.identity)) {
        throw new ZelavisHostOperationValidationError(
          "Host operation artifact parent changed after registration.",
        );
      }
    }
    for (const entry of [
      ...(registration.interpreter?.chain ?? []),
      ...(joinShell?.chain ?? []),
    ]) {
      const stats = await lstat(entry.path).catch(() => undefined);
      if (
        !stats ||
        (entry.directory ? !stats.isDirectory() : !stats.isFile()) ||
        unsafe(stats, entry.identity)
      ) {
        throw new ZelavisHostOperationValidationError(
          "Host operation interpreter changed after registration.",
        );
      }
    }
    const handle = await open(
      registration.file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    ).catch(() => {
      throw new ZelavisHostOperationValidationError(
        "Host operation artifact changed after registration.",
      );
    });
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || unsafe(stats, registration.identity) || (stats.mode & 0o100) === 0) {
        throw new ZelavisHostOperationValidationError(
          "Host operation artifact changed after registration.",
        );
      }
      const body = await handle.readFile();
      if (digest(body) !== registration.manifest.sha256) {
        throw new ZelavisHostOperationValidationError(
          "Host operation artifact changed after registration.",
        );
      }
      return body;
    } finally {
      await handle.close();
    }
  }

  const cgroup = options.supervision?.kind === "cgroup-v2"
    ? await createCgroupV2OperationSupervisor({
        root: options.supervision.root,
        ...(options.supervision.limits ? { limits: options.supervision.limits } : {}),
      })
    : undefined;
  // The join shell runs before the operation, so it is proven like an
  // interpreter and re-proven before every run.
  const joinShell = cgroup
    ? await proveInterpreter(cgroup.joinShell, options.requireRootOwnedArtifacts === true)
    : undefined;

  // Private to this executor: 0700 and owned by the executing identity, so
  // another local user cannot replace a staged copy between verify and exec.
  const stagingDirectory = await mkdtemp(
    join(await realpath(requestedStaging), "zelavis-host-operations-"),
  );

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
      request = validateHostOperationRequest(request, registration.manifest);
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
        const body = await readVerifiedArtifact(registration);
        // Execute a private copy of the verified bytes, never the registered
        // path: the path can be replaced after the digest check, the copy
        // cannot be by anyone but this executor's own identity.
        const staged = join(stagingDirectory, `${randomUUID()}`);
        await writeFile(staged, body, { mode: 0o500, flag: "wx" });
        try {
          validateHostOperationRequest(request, registration.manifest);
          const startedAt = new Date().toISOString();
          const deadlineMs = Date.parse(request.deadline) - Date.now();
          const spawnOptions = {
            shell: false,
            // Its own process group, so the deadline and completion reach
            // every descendant that stays in the group, not only the child.
            detached: true,
            stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
            env: {
              PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
              LANG: "C.UTF-8",
              LC_ALL: "C.UTF-8",
            },
          };
          const scope: CgroupOperationScope | undefined = cgroup ? await cgroup.open() : undefined;
          const args = Object.entries(request.arguments)
            .sort(([left], [right]) => left.localeCompare(right))
            .flatMap(([name, value]) => [`--${name}`, value]);
          const running = new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>((resolveRun, rejectRun) => {
            // A script runs under the interpreter its signed manifest names,
            // never one resolved from a shebang.
            const direct = registration.interpreter
              ? { command: registration.interpreter.path, args: [staged, ...args] }
              : { command: staged, args };
            const launched = scope
              ? scope.wrap(direct.command, direct.args)
              : direct;
            const child = spawn(
              scope && joinShell ? joinShell.path : launched.command,
              launched.args,
              spawnOptions,
            );
            const killAll = () => {
              signalGroup(child.pid, "SIGKILL");
              scope?.kill().catch(() => undefined);
            };
            let stdout = Buffer.alloc(0);
            let stderr = Buffer.alloc(0);
            const append = (current: Buffer, chunk: Buffer) =>
              Buffer.concat([current, chunk]).subarray(0, maxOutputBytes);
            child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
            child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
            child.once("error", rejectRun);
            let timedOut = false;
            let drainTimer: ReturnType<typeof setTimeout> | undefined;
            // A descendant that left the group (a new session) can hold the
            // output pipes open indefinitely. Waiting for them would let it
            // extend the operation past its deadline, so pipes are abandoned
            // shortly after the leader is gone.
            const abandonPipesSoon = () => {
              drainTimer ??= setTimeout(() => {
                child.stdout.destroy();
                child.stderr.destroy();
              }, OUTPUT_DRAIN_GRACE_MS);
            };
            const timer = setTimeout(() => {
              timedOut = true;
              killAll();
              abandonPipesSoon();
            }, deadlineMs);
            // An operation is finished when its leader exits. Descendants left
            // in its group are killed then, rather than outliving the operation
            // or holding its output pipes open until the deadline.
            child.once("exit", () => {
              killAll();
              abandonPipesSoon();
            });
            child.once("close", (code) => {
              clearTimeout(timer);
              if (drainTimer) clearTimeout(drainTimer);
              resolveRun({
                code: code ?? 1,
                stdout: stdout.toString("utf8"),
                stderr: stderr.toString("utf8"),
                timedOut,
              });
            });
          });
          let result: Awaited<typeof running>;
          try {
            result = await running;
          } finally {
            // Everything the operation started, including descendants that
            // left its process group, is gone before the result is reported.
            await scope?.close();
          }
          const declared = registration.manifest.result;
          let parsedResult: Record<string, unknown> | undefined;
          let resultError: string | undefined;
          if (declared && result.code === 0 && !result.timedOut) {
            const text = result.stdout.trim();
            if (new TextEncoder().encode(text).byteLength > declared.maxBytes) {
              resultError = `result exceeds ${declared.maxBytes} bytes`;
            } else {
              try {
                const value = JSON.parse(text) as unknown;
                if (!value || typeof value !== "object" || Array.isArray(value)) {
                  resultError = "result is not a JSON object";
                } else {
                  parsedResult = value as Record<string, unknown>;
                }
              } catch {
                resultError = "result is not valid JSON";
              }
            }
          }
          const operationResult: ZelavisHostOperationResult = {
            operationId: request.operationId,
            operation: request.operation,
            version: request.version,
            status: result.code === 0 && !result.timedOut && !resultError ? "succeeded" : "failed",
            exitCode: result.code,
            ...(parsedResult ? { result: parsedResult } : {}),
            ...(resultError ? { resultError } : {}),
            ...(result.timedOut ? { timedOut: true } : {}),
            stdout: result.stdout,
            stderr: result.stderr,
            startedAt,
            finishedAt: new Date().toISOString(),
          };
          completed.set(request.operationId, { fingerprint, result: operationResult });
          return operationResult;
        } finally {
          await rm(staged, { force: true });
        }
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
