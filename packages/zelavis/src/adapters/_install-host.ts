import { Effect } from "effect";
import { IntegrationFailure, evaluate, integration, present, presentProtocol } from "../core/runtime/effect-boundary.js";
import { requestNodeRuntimeControl } from "./_node-runtime-control.js";
import { restoreHostPackagePolicy } from "./_host-package-policy.js";
import { assertInstallationInstance, installationInstanceScope } from "../core/runtime/installation-instance.js";
import { claimLocalEdgeOwner, releaseLocalEdgeOwner, acquireLocalDataOwnership, readLocalDataOwner, type LocalOwnershipLease } from "./_local-ownership.js";
import { isAlive, processAgeMs } from "./_agent-process-runner.js";
import type { ZelavisInstallationProbeHost } from "../core/runtime/installation-health.js";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, appendFile, chmod, cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ZelavisInstallPaths } from "../core/runtime/installation-plan.js";
import type { ZelavisWorkerInstallPaths } from "../core/runtime/worker-installation-plan.js";

const exec = promisify(execFile);

export function nodeInstallationPaths(env: NodeJS.ProcessEnv = process.env, instance = "default"): ZelavisInstallPaths {
  assertInstallationInstance(instance);
  const suffix = instance === "default" ? "" : `-${instance}`;
  const bin = env.ZELAVIS_BIN_DIR ?? "/usr/local/bin";
  return {
    instance,
    prefix: env.ZELAVIS_PREFIX ?? "/opt/zelavis",
    dataDirectory: `${env.ZELAVIS_DATA_DIR ?? "/var/lib/zelavis"}${suffix}`,
    configDirectory: `${env.ZELAVIS_UNINSTALL_ETC_DIR ?? "/etc/zelavis"}${suffix}`,
    commandPath: env.ZELAVIS_UNINSTALL_COMMAND ?? join(bin, "zelavis"),
    systemCommandPath: env.ZELAVIS_UNINSTALL_SYSTEM_BIN ?? "/usr/bin/zelavis",
    systemdDirectories: [env.ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR ?? "/etc/systemd/system", env.ZELAVIS_UNINSTALL_SYSTEMD_LIB_DIR ?? "/lib/systemd/system", env.ZELAVIS_UNINSTALL_SYSTEMD_USR_LIB_DIR ?? "/usr/lib/systemd/system"],
  };
}

/** A worker keeps its data beside the Platform's default location, under its own name. */
export function nodeWorkerInstallationPaths(env: NodeJS.ProcessEnv = process.env): ZelavisWorkerInstallPaths {
  const base = nodeInstallationPaths(env);
  return {
    prefix: base.prefix,
    dataDirectory: `${env.ZELAVIS_DATA_DIR ?? "/var/lib/zelavis"}-worker`,
    commandPath: base.commandPath,
    systemCommandPath: base.systemCommandPath,
    systemdDirectories: base.systemdDirectories,
  };
}

/** User state is entirely below the user's private prefix, except its command. */
export function nodeUserInstallationPaths(home = realpathSync(homedir())): ZelavisInstallPaths {
  const prefix = join(home, ".local/share/zelavis");
  return { ...nodeInstallationPaths(), prefix, dataDirectory: join(prefix, "data"), configDirectory: join(prefix, "config"), commandPath: join(home, ".local/bin/zelavis") };
}

/** A system installation's paths need root; anything else is an isolated test or a user install. */
export function assertNodeInstallationPrivilege(paths: ZelavisInstallPaths, skipHostCommands = false): void {
  if (skipHostCommands || process.getuid?.() === 0) return;
  for (const path of [paths.prefix, paths.dataDirectory, paths.configDirectory, paths.commandPath, paths.systemCommandPath, ...paths.systemdDirectories]) {
    if (/^\/(?:etc|usr|var|opt|lib)\//u.test(path)) throw new Error("Installation maintenance of a system installation must run as root.");
  }
}

const codeOf = (failure: { readonly cause?: unknown }): string | number | undefined =>
  (failure.cause as { code?: string | number } | undefined)?.code;

/** An fs call whose only expected failure is that the thing is not there. */
const orMissing = <A>(operation: () => Promise<A>, codes: readonly (string | number)[] = ["ENOENT"]) =>
  integration(operation).pipe(
    Effect.map((value): A | undefined => value),
    Effect.catch((failure) => codes.includes(codeOf(failure) ?? "") ? Effect.succeed(undefined) : Effect.fail(failure)),
  );

/** Scratch files beside an atomic target are removed whether or not the step succeeded. */
const removeScratch = (path: string, recursive = false) => integration(() => rm(path, { recursive, force: true })).pipe(Effect.orDie);

const lsofListeners = (port: number) => integration(() => exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 })).pipe(
  Effect.map((result) => result.stdout.trim()),
  // lsof exits 1 with no output when nothing is listening.
  Effect.catch((failure) => {
    const cause = failure.cause as { code?: number; stdout?: string } | undefined;
    return cause?.code === 1 && !cause.stdout?.trim() ? Effect.succeed("") : Effect.fail(failure);
  }),
);

/** No shell evaluation: commands use an executable and literal argv. */
export function createNodeInstallHost(options: { invokingPath?: string } = {}): ZelavisInstallationProbeHost {
  let maintenance: LocalOwnershipLease | undefined;

  const listeningInodes = (port: number) => Effect.gen(function* () {
    const tables = yield* Effect.forEach(["tcp", "tcp6"], (table) => integration(() => host.read(`/proc/net/${table}`)), { concurrency: 2 });
    if (tables.every((table) => table === undefined)) return yield* new IntegrationFailure(new Error("Cannot inspect listening TCP ports on this host."));
    return new Set(tables.flatMap((table) => (table ?? "").trim().split("\n").slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields[3] === "0A" && parseInt(fields[1]?.split(":").at(-1) ?? "", 16) === port)
      .map((fields) => fields[9])));
  });

  const host: ZelavisInstallationProbeHost = {
    releaseMaintenance: () => present(Effect.gen(function* () {
      const lease = maintenance;
      maintenance = undefined;
      if (lease) yield* integration(() => lease.release());
    })),
    dataOwnership: path => present(Effect.gen(function* () {
      const owner = yield* integration(() => readLocalDataOwner(path));
      if (!owner || !isAlive(owner.pid)) return { active: false };
      const age = yield* integration(() => processAgeMs(owner.pid));
      const active = age === undefined || Math.abs(age - (Date.now() - Date.parse(owner.startedAt))) <= 30_000;
      let supervisorPid: number | undefined;
      if (active && owner.purpose === "platform") {
        const status = yield* requestNodeRuntimeControl(join(path, "runtime-control.sock"), { action: "status" }).pipe(Effect.timeoutOrElse({ duration: 5_000, orElse: () => Effect.void }), Effect.orElseSucceed(() => undefined));
        if (status?.protocol === "zelavis-runtime/1" && status.ready && Number.isSafeInteger(status.supervisorPid)) {
          const parent = yield* (process.platform === "linux"
            ? integration(() => readFile(`/proc/${owner.pid}/status`, "utf8")).pipe(Effect.map(source => Number(/^PPid:\s+(\d+)$/m.exec(source)?.[1])))
            : integration(() => exec("ps", ["-p", String(owner.pid), "-o", "ppid="])).pipe(Effect.map(result => Number(result.stdout.trim()))))
            .pipe(Effect.orElseSucceed(() => undefined));
          if (parent === status.supervisorPid) supervisorPid = parent;
        }
      }
      return { active, pid: owner.pid, ...(supervisorPid ? { supervisorPid } : {}), installationRoot: owner.installationRoot, purpose: owner.purpose };
    })),
    portAvailable: (port) => present(Effect.gen(function* () {
      // Read-only inspection: a temporary bind would itself look like a
      // foreign listener to another installer or doctor running concurrently.
      if (process.platform === "linux") return (yield* listeningInodes(port)).size === 0;
      return (yield* lsofListeners(port)) === "";
    })),
    portOwnedBy: (pid, port) => present(Effect.gen(function* () {
      if (process.platform !== "linux") {
        return yield* lsofListeners(port).pipe(
          Effect.map((owners) => owners.split("\n").every((owner) => owner === String(pid))),
          Effect.orElseSucceed(() => false),
        );
      }
      const inodes = yield* listeningInodes(port);
      if (!inodes.size) return false;
      return yield* Effect.gen(function* () {
        const descriptors = yield* integration(() => readdir(`/proc/${pid}/fd`));
        const targets = yield* Effect.forEach(descriptors, (fd) => integration(() => host.readlink(`/proc/${pid}/fd/${fd}`)), { concurrency: 16 });
        const owned = new Set<string>();
        for (const target of targets) {
          const match = /^socket:\[(\d+)\]$/u.exec(target ?? "");
          if (match && inodes.has(match[1]!)) owned.add(match[1]!);
        }
        return [...inodes].every((inode) => owned.has(inode));
      }).pipe(Effect.orElseSucceed(() => false));
    })),
    unitState: (unit, paths) => present(Effect.gen(function* () {
      const template = unit.includes("@") ? unit.replace(/@[^.]+\.service$/u, "@.service") : unit;
      const found = yield* Effect.forEach(paths.systemdDirectories, (directory) => integration(() => host.exists(join(directory, template))), { concurrency: 4 });
      const isPresent = found.some(Boolean);
      if (!(yield* integration(() => host.which("systemctl")))) return { present: isPresent, active: false, enabled: false };
      // systemctl answers non-zero for an inactive or disabled unit; that is an answer, not a failure.
      const query = (args: string[]) => integration(() => exec("systemctl", args, { timeout: 5_000 })).pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.orElseSucceed(() => ""),
      );
      const [enabled, active, pid, delegated] = yield* Effect.all([
        query(["is-enabled", unit]), query(["is-active", unit]),
        query(["show", "--property=MainPID", "--value", unit]), query(["show", "--property=Delegate", "--value", unit]),
      ], { concurrency: 4 });
      return { present: isPresent, enabled: enabled === "enabled", active: active === "active", ...(Number(pid) > 0 ? { pid: Number(pid) } : {}), delegates: delegated === "yes" };
    })),
    listInstances: (prefix) => present(Effect.gen(function* () {
      const instances: string[] = [];
      if (yield* integration(() => host.exists(`${prefix}/installation.json`))) instances.push("default");
      const entries = (yield* orMissing(() => readdir(`${prefix}/instances`))) ?? [];
      for (const entry of entries) {
        yield* evaluate(() => assertInstallationInstance(entry));
        if (yield* integration(() => host.exists(installationInstanceScope(prefix, entry).receipt))) instances.push(entry);
      }
      return instances;
    })),
    dataOwner: (path, account) => present(Effect.gen(function* () {
      const info = yield* orMissing(() => stat(path));
      if (!info) return undefined;
      const expectedUid = account === undefined
        ? process.getuid?.()
        : yield* integration(() => exec("id", ["-u", account])).pipe(Effect.map((result) => Number(result.stdout.trim())), Effect.orElseSucceed(() => undefined));
      return { uid: info.uid, expectedUid };
    })),
    agentSupport: (unit = "zelavis-agent.service") => present(Effect.gen(function* () {
      const cgroupV2 = yield* integration(() => host.exists("/sys/fs/cgroup/cgroup.controllers"));
      // An unavailable unit provides no cgroup supervision proof.
      const group = process.platform === "linux" && (yield* integration(() => host.which("systemctl")))
        ? yield* integration(() => exec("systemctl", ["show", "--property=ControlGroup", "--value", unit], { timeout: 5_000 })).pipe(
            Effect.map((result) => result.stdout.trim()), Effect.orElseSucceed(() => ""))
        : "";
      const safeGroup = group.startsWith("/") && !group.split("/").includes("..");
      return { cgroupV2, cgroupKill: safeGroup && (yield* integration(() => host.exists(`/sys/fs/cgroup${group}/cgroup.kill`))) };
    }).pipe(Effect.withSpan("createNodeInstallHost/host/agentSupport"))),
    exists: (path) => present(orMissing(() => lstat(path)).pipe(Effect.map((info) => info !== undefined))),
    read: (path) => present(orMissing(() => readFile(path, "utf8"))),
    readlink: (path) => present(orMissing(() => readlink(path), ["ENOENT", "EINVAL"])),
    which: (command, plannedCommandPath) => present(Effect.gen(function* () {
      for (const directory of (command === "zelavis" ? options.invokingPath ?? process.env.PATH ?? "" : process.env.PATH ?? "").split(":")) {
        const path = join(directory, command);
        if (path === plannedCommandPath) return path;
        // Not there, not a directory, or not ours to execute: keep looking. Anything else is a real failure.
        const found = yield* orMissing(() => access(path, constants.X_OK).then(() => true), ["ENOENT", "ENOTDIR", "EACCES"]);
        if (found) return path;
      }
      return undefined;
    }).pipe(Effect.withSpan("createNodeInstallHost/host/which"))),
    accountExists: (kind, name) => present(
      integration(() => exec(kind === "group" ? "getent" : "id", kind === "group" ? ["group", name] : [name])).pipe(
        Effect.as(true),
        // Both tools exit non-zero when the account does not exist.
        Effect.orElseSucceed(() => false),
      ),
    ),
    execute: (action) => presentProtocol(Effect.gen(function* () {
      switch (action.kind) {
        case "reserve-data": maintenance = yield* integration(() => acquireLocalDataOwnership(action.path, "maintenance")); return undefined;
        case "release-data": yield* integration(() => host.releaseMaintenance?.()); return undefined;
        case "mkdir":
          yield* integration(() => mkdir(action.path, { recursive: true, mode: action.mode }));
          if (action.mode !== undefined) yield* integration(() => chmod(action.path, action.mode!));
          return undefined;
        case "copy": {
          // A failed copy never becomes a release. The next run can repair it.
          const temporary = `${action.path}.install-${process.pid}`;
          yield* Effect.gen(function* () {
            yield* integration(() => cp(action.source, temporary, { recursive: true, verbatimSymlinks: true }));
            yield* integration(() => rename(temporary, action.path));
          }).pipe(Effect.ensuring(removeScratch(temporary, true)));
          return undefined;
        }
        case "link": {
          if (action.atomic) {
            // current's scratch link lives under the owned installation root.
            const temporary = `${action.path}.install-${process.pid}`;
            yield* Effect.gen(function* () {
              yield* integration(() => symlink(action.target, temporary));
              yield* integration(() => rename(temporary, action.path));
            }).pipe(Effect.ensuring(removeScratch(temporary)));
            return undefined;
          }
          // No scratch links outside the owned installation tree. In
          // particular a crash must not leave /usr/bin/zelavis.install-*.
          yield* integration(() => rm(action.path, { force: true }));
          yield* integration(() => symlink(action.target, action.path));
          return undefined;
        }
        case "write": {
          yield* integration(() => mkdir(dirname(action.path), { recursive: true }));
          if (action.ifAbsent) {
            const written = yield* integration(() => writeFile(action.path, action.content, { mode: action.mode, flag: "wx" }).then(() => true)).pipe(
              Effect.catch((failure) => codeOf(failure) === "EEXIST" ? Effect.succeed(false) : Effect.fail(failure)),
            );
            // Something is already there and is kept, mode included.
            if (!written) return undefined;
          } else if (action.atomic) {
            const temporary = `${action.path}.install-${process.pid}`;
            yield* Effect.gen(function* () {
              yield* integration(() => writeFile(temporary, action.content, { mode: action.mode, flag: "wx" }));
              yield* integration(() => chmod(temporary, action.mode));
              yield* integration(() => rename(temporary, action.path));
            }).pipe(Effect.ensuring(removeScratch(temporary)));
          } else {
            yield* integration(() => writeFile(action.path, action.content, { mode: action.mode }));
          }
          yield* integration(() => chmod(action.path, action.mode));
          return undefined;
        }
        case "bootstrap": {
          if (yield* integration(() => host.exists(action.path))) return undefined;
          const token = randomBytes(32).toString("hex");
          const environment = `ZELAVIS_BOOTSTRAP_TOKEN=${token}\n` + (action.dataDirectory ? `ZELAVIS_DATA_DIR=${JSON.stringify(action.dataDirectory)}\nHOST=${action.public ? "0.0.0.0" : "127.0.0.1"}\n` : "");
          const created = yield* integration(() => writeFile(action.path, environment, { mode: 0o600, flag: "wx" }).then(() => true)).pipe(
            Effect.catch((failure) => codeOf(failure) === "EEXIST" ? Effect.succeed(false) : Effect.fail(failure)),
          );
          return created ? `First-run bootstrap token: ${token}\nEnter it in the dashboard setup wizard or run: zelavis setup` : undefined;
        }
        case "agent-environment": {
          const content = (yield* integration(() => host.read(action.path))) ?? "";
          const variable = action.variable ?? "ZELAVIS_AGENT_ENDPOINT";
          if (!new RegExp(`^${variable}=`, "mu").test(content)) yield* integration(() => appendFile(action.path, `${content && !content.endsWith("\n") ? "\n" : ""}${variable}=${action.endpoint}\n`));
          return undefined;
        }
        case "command":
          yield* integration(() => exec(action.command, [...action.args], { maxBuffer: 1024 * 1024 })).pipe(
            Effect.catch((failure) => action.ignoreFailure ? Effect.void : Effect.fail(failure)),
          );
          return undefined;
        case "remove": yield* integration(() => rm(action.path, { recursive: action.recursive, force: true })); return undefined;
        case "remove-link": {
          const target = yield* integration(() => host.readlink(action.path));
          if (target?.startsWith(`${action.prefix}/`)) {
            yield* integration(() => rm(action.path, { force: true }));
            return undefined;
          }
          if (target || (yield* integration(() => host.exists(action.path)))) return `Retaining foreign command at ${action.path}${target ? ` -> ${target}` : ""}`;
          return undefined;
        }
        case "restore-package-policy": return yield* integration(() => restoreHostPackagePolicy(action.stateDirectory, action.policy));
        case "purge-packages": {
          if (!(yield* integration(() => host.which("dpkg-query"))) || !(yield* integration(() => host.which("apt-get")))) return undefined;
          const installed = yield* integration(() => exec("dpkg-query", ["-W", "-f=${db:Status-Abbrev}", "zelavis"])).pipe(
            Effect.map((result) => result.stdout.startsWith("ii")),
            // dpkg-query exits 1 when the named package is not installed.
            Effect.catch((failure) => codeOf(failure) === 1 ? Effect.succeed(false) : Effect.fail(failure)),
          );
          if (installed) yield* integration(() => exec("apt-get", ["purge", "-y", "zelavis"], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } }));
          return undefined;
        }
        case "claim-edge": yield* integration(() => claimLocalEdgeOwner(action)); return undefined;
        case "release-edge": yield* integration(() => releaseLocalEdgeOwner(action)); return undefined;
        case "remove-account": {
          const account = action.account ?? "zelavis";
          if (!(yield* integration(() => host.which("getent")))) return undefined;
          const messages: string[] = [];
          if (yield* integration(() => host.accountExists("user", account))) {
            const fields = (yield* integration(() => exec("getent", ["passwd", account]))).stdout.trim().split(":");
            if (action.ownsUser && fields[5] === action.dataDirectory && /\/(?:nologin|false)$/u.test(fields[6] ?? "")) {
              // A failed userdel leaves the account, and says so; it does not stop the rest of the removal.
              yield* integration(() => exec("userdel", [account])).pipe(Effect.catch(() => Effect.sync(() => { messages.push(`Retaining ${account} account: userdel failed.`); })));
            } else messages.push(`Retaining ${account} account: ownership or current properties do not prove a dedicated installer account.`);
          }
          if (yield* integration(() => host.accountExists("group", account))) {
            if (action.ownsGroup) {
              yield* integration(() => exec("groupdel", [account])).pipe(Effect.catch(() => Effect.sync(() => { messages.push(`Retaining ${account} group because another account still uses it.`); })));
            } else messages.push(`Retaining ${account} group: the installer did not record creating it.`);
          }
          return messages.join("\n") || undefined;
        }
      }
    }).pipe(Effect.withSpan("createNodeInstallHost/host/execute"))),
  };
  return host;
}
