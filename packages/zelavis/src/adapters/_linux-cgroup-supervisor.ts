import { randomUUID } from "node:crypto";
import { access, lstat, mkdir, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * cgroup v2 containment for short host operations.
 *
 * A process group is not a containment boundary: a descendant that starts a
 * new session leaves it and survives the kill. A cgroup is: every process an
 * operation starts is born inside the operation's cgroup, and `cgroup.kill`
 * reaches all of them regardless of session or process group.
 *
 * Linux only. The Agent must be given a dedicated delegated subtree (systemd
 * `Delegate=yes`, or `systemd-run --scope -p Delegate=yes`) that it runs
 * outside of; see the operator runbook. Nothing here falls back to weaker
 * supervision: a supervisor that cannot be proven usable refuses to exist.
 */
export interface CgroupOperationLimits {
  /** `memory.max` for each operation, in bytes. */
  readonly memoryMaxBytes?: number;
  /** `pids.max` for each operation. */
  readonly pidsMax?: number;
}

export interface CgroupV2SupervisorOptions {
  /** Delegated cgroup directory under `/sys/fs/cgroup` that holds no processes. */
  readonly root: string;
  readonly limits?: CgroupOperationLimits;
  /** Shell used only to join the cgroup before `exec`. Defaults to `/bin/sh`. */
  readonly joinShell?: string;
  /** Test/host override; defaults to `process.platform`. */
  readonly platform?: string;
}

export interface CgroupOperationScope {
  readonly path: string;
  /** Command and argv that join this cgroup, then `exec` the real command. */
  wrap(command: string, args: readonly string[]): { command: string; args: string[] };
  /** Kills every process in the cgroup. Safe to call repeatedly. */
  kill(): Promise<void>;
  /** Kills, waits for the cgroup to empty, then removes it. */
  close(): Promise<void>;
}

export interface CgroupV2OperationSupervisor {
  readonly kind: "cgroup-v2";
  readonly root: string;
  readonly joinShell: string;
  /** Removed leftovers from an earlier Agent, reported once at creation. */
  readonly reclaimed: number;
  open(): Promise<CgroupOperationScope>;
}

export class CgroupSupervisionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CgroupSupervisionUnavailableError";
  }
}

const OPERATION_PREFIX = "zelavis-op-";
const EMPTY_WAIT_MS = 5_000;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

async function populated(path: string): Promise<boolean> {
  const events = await readFile(join(path, "cgroup.events"), "utf8").catch(() => "");
  return /^populated 1$/m.test(events);
}

async function killAndRemove(path: string): Promise<void> {
  await writeFile(join(path, "cgroup.kill"), "1").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  const until = Date.now() + EMPTY_WAIT_MS;
  while (await populated(path)) {
    if (Date.now() > until) {
      throw new CgroupSupervisionUnavailableError(
        `Operation cgroup ${path} still has processes ${EMPTY_WAIT_MS} ms after cgroup.kill.`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  await rmdir(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

function validateLimits(limits: CgroupOperationLimits | undefined) {
  if (!limits) return;
  if (
    limits.memoryMaxBytes !== undefined &&
    (!Number.isSafeInteger(limits.memoryMaxBytes) || limits.memoryMaxBytes < 4 * 1024 * 1024)
  ) {
    throw new CgroupSupervisionUnavailableError("memoryMaxBytes must be an integer of at least 4 MiB.");
  }
  if (
    limits.pidsMax !== undefined &&
    (!Number.isSafeInteger(limits.pidsMax) || limits.pidsMax < 1)
  ) {
    throw new CgroupSupervisionUnavailableError("pidsMax must be a positive integer.");
  }
}

/**
 * Proves the delegated subtree is usable, reclaims leftovers, and enables the
 * controllers the limits need.
 */
export async function createCgroupV2OperationSupervisor(
  options: CgroupV2SupervisorOptions,
): Promise<CgroupV2OperationSupervisor> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new CgroupSupervisionUnavailableError(
      `cgroup v2 supervision requires Linux; this host is ${platform}.`,
    );
  }
  validateLimits(options.limits);
  const root = options.root;
  if (!root.startsWith("/sys/fs/cgroup/") || root.split("/").includes("..")) {
    throw new CgroupSupervisionUnavailableError(
      "cgroup supervision root must be a normalized directory below /sys/fs/cgroup.",
    );
  }
  const rootStats = await lstat(root).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw new CgroupSupervisionUnavailableError(`cgroup supervision root ${root} is not a directory.`);
  }
  if (!(await exists(join(root, "cgroup.controllers")))) {
    throw new CgroupSupervisionUnavailableError(`${root} is not on a cgroup v2 (unified) hierarchy.`);
  }
  // `cgroup.kill` (Linux 5.14+) is what makes the kill complete; without it a
  // freeze-and-signal loop would be needed, which this does not attempt.
  if (!(await exists(join(root, "cgroup.kill")))) {
    throw new CgroupSupervisionUnavailableError(
      `${root} has no cgroup.kill; Linux 5.14 or later is required.`,
    );
  }
  const rootProcesses = (await readFile(join(root, "cgroup.procs"), "utf8")).trim();
  if (rootProcesses) {
    throw new CgroupSupervisionUnavailableError(
      `${root} contains processes; the Agent must run outside the operations subtree (for example in a sibling leaf).`,
    );
  }

  // Delegation proof: creating and removing a child is the permission that
  // matters, not a mode bit.
  const probe = join(root, `zelavis-probe-${randomUUID()}`);
  try {
    await mkdir(probe);
    await rmdir(probe);
  } catch (error) {
    throw new CgroupSupervisionUnavailableError(
      `${root} is not delegated to this Agent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let reclaimed = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(OPERATION_PREFIX)) {
      await killAndRemove(join(root, entry.name));
      reclaimed += 1;
    }
  }

  const controllers: string[] = [];
  if (options.limits?.memoryMaxBytes !== undefined) controllers.push("memory");
  if (options.limits?.pidsMax !== undefined) controllers.push("pids");
  if (controllers.length > 0) {
    const available = (await readFile(join(root, "cgroup.controllers"), "utf8")).trim().split(/\s+/);
    const missing = controllers.filter((controller) => !available.includes(controller));
    if (missing.length > 0) {
      throw new CgroupSupervisionUnavailableError(
        `${root} does not delegate the ${missing.join(", ")} controller(s).`,
      );
    }
    await writeFile(
      join(root, "cgroup.subtree_control"),
      controllers.map((controller) => `+${controller}`).join(" "),
    );
  }

  const joinShell = options.joinShell ?? "/bin/sh";
  return {
    kind: "cgroup-v2",
    root,
    joinShell,
    reclaimed,
    async open() {
      const path = join(root, `${OPERATION_PREFIX}${randomUUID()}`);
      await mkdir(path);
      try {
        if (options.limits?.memoryMaxBytes !== undefined) {
          await writeFile(join(path, "memory.max"), String(options.limits.memoryMaxBytes));
          // No swap escape from the memory ceiling.
          await writeFile(join(path, "memory.swap.max"), "0").catch(() => undefined);
        }
        if (options.limits?.pidsMax !== undefined) {
          await writeFile(join(path, "pids.max"), String(options.limits.pidsMax));
        }
      } catch (error) {
        await rmdir(path).catch(() => undefined);
        throw error;
      }
      let closed: Promise<void> | undefined;
      return {
        path,
        wrap(command, args) {
          // The shell moves itself into the cgroup, then becomes the command
          // with the same pid. Nothing the operation runs exists before the
          // move, so nothing can be born outside the cgroup.
          return {
            command: joinShell,
            args: [
              "-c",
              'echo 0 > "$0" && exec "$@"',
              join(path, "cgroup.procs"),
              command,
              ...args,
            ],
          };
        },
        async kill() {
          await writeFile(join(path, "cgroup.kill"), "1").catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        },
        close() {
          closed ??= killAndRemove(path);
          return closed;
        },
      };
    },
  };
}

/**
 * Lays out the cgroup this process was delegated (systemd `Delegate=yes`):
 * the process moves itself into an `agent` leaf, operations get an
 * `operations` sibling, and the requested controllers are enabled for the
 * subtree. cgroup v2 forbids processes in a cgroup that distributes
 * controllers to children, which is why the Agent cannot stay where systemd
 * started it. Returns the operations root for `createCgroupV2OperationSupervisor`.
 */
export async function prepareDelegatedCgroupLayout(options: {
  readonly controllers?: readonly ("memory" | "pids")[];
  readonly platform?: string;
} = {}): Promise<{ readonly agent: string; readonly operations: string }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") {
    throw new CgroupSupervisionUnavailableError(
      `Delegated cgroup layout requires Linux; this host is ${platform}.`,
    );
  }
  const membership = await readFile("/proc/self/cgroup", "utf8").catch(() => "");
  const unified = membership.split("\n").find((line) => line.startsWith("0::"));
  if (!unified) {
    throw new CgroupSupervisionUnavailableError(
      "This process is not on a cgroup v2 unified hierarchy.",
    );
  }
  let base = join("/sys/fs/cgroup", unified.slice(3).trim());
  if (base === "/sys/fs/cgroup" || base === "/sys/fs/cgroup/") {
    throw new CgroupSupervisionUnavailableError(
      "This process runs in the root cgroup; start the Agent in a delegated unit or scope.",
    );
  }
  // A restarted process inherits nothing, but a layout already prepared by
  // this process (or a wrapper) is reused rather than nested again.
  if (base.endsWith("/agent") && await exists(join(base, "..", "operations"))) {
    base = join(base, "..");
  }
  const agent = join(base, "agent");
  const operations = join(base, "operations");
  try {
    await mkdir(agent, { recursive: true });
    await mkdir(operations, { recursive: true });
    await writeFile(join(agent, "cgroup.procs"), String(process.pid));
  } catch (error) {
    throw new CgroupSupervisionUnavailableError(
      `${base} is not delegated to this process: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const requested = options.controllers ?? [];
  if (requested.length > 0) {
    const available = (await readFile(join(base, "cgroup.controllers"), "utf8")).trim().split(/\s+/);
    const missing = requested.filter((controller) => !available.includes(controller));
    if (missing.length > 0) {
      throw new CgroupSupervisionUnavailableError(
        `${base} does not delegate the ${missing.join(", ")} controller(s).`,
      );
    }
    await writeFile(
      join(base, "cgroup.subtree_control"),
      requested.map((controller) => `+${controller}`).join(" "),
    );
  }
  return { agent, operations };
}
