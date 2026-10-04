import { Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
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

const exec = promisify(execFile);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

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

/** User state is entirely below the user's private prefix, except its command. */
export function nodeUserInstallationPaths(home = realpathSync(homedir())): ZelavisInstallPaths {
  const prefix = join(home, ".local/share/zelavis");
  return { ...nodeInstallationPaths(), prefix, dataDirectory: join(prefix, "data"), configDirectory: join(prefix, "config"), commandPath: join(home, ".local/bin/zelavis") };
}

export async function assertNodeInstallationPrivilege(paths: ZelavisInstallPaths, skipHostCommands = false): Promise<void> {
  if (skipHostCommands || process.getuid?.() === 0) return;
  for (const path of [paths.prefix, paths.dataDirectory, paths.configDirectory, paths.commandPath, paths.systemCommandPath, ...paths.systemdDirectories]) {
    if (/^\/(?:etc|usr|var|opt|lib)\//u.test(path)) throw new Error("Installation maintenance of a system installation must run as root.");
  }
}

/** No shell evaluation: commands use an executable and literal argv. */
export function createNodeInstallHost(options: { invokingPath?: string } = {}): ZelavisInstallationProbeHost {
  let maintenance: LocalOwnershipLease | undefined;
  const listeningInodes = async (port: number) => {
    const tables = await Promise.all(["tcp", "tcp6"].map((table) => host.read(`/proc/net/${table}`)));
    if (tables.every((table) => table === undefined)) throw new Error("Cannot inspect listening TCP ports on this host.");
    return new Set(tables.flatMap((table) => (table ?? "").trim().split("\n").slice(1)
      .map((line) => line.trim().split(/\s+/u))
      .filter((fields) => fields[3] === "0A" && parseInt(fields[1]?.split(":").at(-1) ?? "", 16) === port)
      .map((fields) => fields[9])));
  };
  const host: ZelavisInstallationProbeHost = {
    async releaseMaintenance() { const lease = maintenance; maintenance = undefined; await lease?.release(); },
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
    async portAvailable(port) {
      // Read-only inspection: a temporary bind would itself look like a
      // foreign listener to another installer or doctor running concurrently.
      if (process.platform === "linux") return (await listeningInodes(port)).size === 0;
      try { return !(await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 })).stdout.trim(); }
      catch (error) {
        if ((error as { code?: number }).code === 1 && !(error as { stdout?: string }).stdout?.trim()) return true;
        throw error;
      }
    },
    async portOwnedBy(pid, port) {
      if (process.platform !== "linux") {
        try { return (await exec("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 })).stdout.trim().split("\n").every((owner) => owner === String(pid)); } catch { return false; }
      }
      const inodes = await listeningInodes(port);
      if (!inodes.size) return false;
      try {
        const owned = new Set<string>();
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const target = await host.readlink(`/proc/${pid}/fd/${fd}`);
          const match = /^socket:\[(\d+)\]$/u.exec(target ?? "");
          if (match && inodes.has(match[1])) owned.add(match[1]);
        }
        return [...inodes].every((inode) => owned.has(inode));
      } catch { return false; }
    },
    async unitState(unit, paths) {
      const present = (await Promise.all(paths.systemdDirectories.map((directory) => host.exists(join(directory, unit.includes("@") ? unit.replace(/@[^.]+\.service$/u, "@.service") : unit))))).some(Boolean);
      if (!await host.which("systemctl")) return { present, active: false, enabled: false };
      const query = async (args: string[]) => { try { return (await exec("systemctl", args, { timeout: 5_000 })).stdout.trim(); } catch { return ""; } };
      const [enabled, active, pid, delegated] = await Promise.all([query(["is-enabled", unit]), query(["is-active", unit]), query(["show", "--property=MainPID", "--value", unit]), query(["show", "--property=Delegate", "--value", unit])]);
      return { present, enabled: enabled === "enabled", active: active === "active", ...(Number(pid) > 0 ? { pid: Number(pid) } : {}), delegates: delegated === "yes" };
    },
    async listInstances(prefix) {
      const instances: string[] = [];
      if (await host.exists(`${prefix}/installation.json`)) instances.push("default");
      try { for (const entry of await readdir(`${prefix}/instances`)) {
        assertInstallationInstance(entry);
        if (await host.exists(installationInstanceScope(prefix, entry).receipt)) instances.push(entry);
      } } catch (error) { if (!missing(error)) throw error; }
      return instances;
    },
    async dataOwner(path, account) {
      try {
        const info = await stat(path);
        let expectedUid = process.getuid?.();
        if (account) {
          try { expectedUid = Number((await exec("id", ["-u", account])).stdout.trim()); } catch { expectedUid = undefined; }
        }
        return { uid: info.uid, expectedUid };
      } catch (error) { if (missing(error)) return undefined; throw error; }
    },
    async agentSupport(unit = "zelavis-agent.service") {
      const cgroupV2 = await host.exists("/sys/fs/cgroup/cgroup.controllers");
      let group = "";
      if (process.platform === "linux" && await host.which("systemctl")) {
        try { group = (await exec("systemctl", ["show", "--property=ControlGroup", "--value", unit], { timeout: 5_000 })).stdout.trim(); } catch {}
      }
      const safeGroup = group.startsWith("/") && !group.split("/").includes("..");
      return { cgroupV2, cgroupKill: safeGroup && await host.exists(`/sys/fs/cgroup${group}/cgroup.kill`) };
    },
    async exists(path) {
      try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
    },
    async read(path) {
      try { return await readFile(path, "utf8"); } catch (error) { if (missing(error)) return undefined; throw error; }
    },
    async readlink(path) {
      try { return await readlink(path); } catch (error) {
        if (missing(error) || (error as NodeJS.ErrnoException).code === "EINVAL") return undefined;
        throw error;
      }
    },
    async which(command, plannedCommandPath) {
      for (const directory of (command === "zelavis" ? options.invokingPath ?? process.env.PATH ?? "" : process.env.PATH ?? "").split(":")) {
        const path = join(directory, command);
        if (path === plannedCommandPath) return path;
        try { await access(path, constants.X_OK); return path; } catch {}
      }
      return undefined;
    },
    async accountExists(kind, name) {
      try { await exec(kind === "group" ? "getent" : "id", kind === "group" ? ["group", name] : [name]); return true; } catch { return false; }
    },
    async execute(action) {
      switch (action.kind) {
        case "reserve-data": maintenance = await acquireLocalDataOwnership(action.path, "maintenance"); break;
        case "release-data": await host.releaseMaintenance?.(); break;
        case "mkdir":
          await mkdir(action.path, { recursive: true, mode: action.mode });
          if (action.mode !== undefined) await chmod(action.path, action.mode);
          break;
        case "copy": {
          // A failed copy never becomes a release. The next run can repair it.
          const temporary = `${action.path}.install-${process.pid}`;
          try {
            await cp(action.source, temporary, { recursive: true, verbatimSymlinks: true });
            await rename(temporary, action.path);
          } finally { await rm(temporary, { recursive: true, force: true }); }
          break;
        }
        case "link": {
          if (action.atomic) {
            // current's scratch link lives under the owned installation root.
            const temporary = `${action.path}.install-${process.pid}`;
            try {
              await symlink(action.target, temporary);
              await rename(temporary, action.path);
            } finally { await rm(temporary, { force: true }); }
            break;
          }
          // No scratch links outside the owned installation tree. In
          // particular a crash must not leave /usr/bin/zelavis.install-*.
          await rm(action.path, { force: true });
          await symlink(action.target, action.path);
          break;
        }
        case "write": {
          await mkdir(dirname(action.path), { recursive: true });
          if (action.ifAbsent) {
            try { await writeFile(action.path, action.content, { mode: action.mode, flag: "wx" }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; break; }
          } else if (action.atomic) {
            const temporary = `${action.path}.install-${process.pid}`;
            try {
              await writeFile(temporary, action.content, { mode: action.mode, flag: "wx" });
              await chmod(temporary, action.mode);
              await rename(temporary, action.path);
            } finally { await rm(temporary, { force: true }); }
          } else {
            await writeFile(action.path, action.content, { mode: action.mode });
          }
          await chmod(action.path, action.mode);
          break;
        }
        case "bootstrap": {
          if (await host.exists(action.path)) break;
          const token = randomBytes(32).toString("hex");
          const environment = `ZELAVIS_BOOTSTRAP_TOKEN=${token}\n` + (action.dataDirectory ? `ZELAVIS_DATA_DIR=${JSON.stringify(action.dataDirectory)}\nHOST=${action.public ? "0.0.0.0" : "127.0.0.1"}\n` : "");
          try { await writeFile(action.path, environment, { mode: 0o600, flag: "wx" }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") break; throw error; }
          return `First-run bootstrap token: ${token}\nEnter it in the dashboard setup wizard or run: zelavis setup`;
        }
        case "agent-environment": {
          const content = await host.read(action.path) ?? "";
          const variable = action.variable ?? "ZELAVIS_AGENT_ENDPOINT";
          if (!new RegExp(`^${variable}=`, "mu").test(content)) await appendFile(action.path, `${content && !content.endsWith("\n") ? "\n" : ""}${variable}=${action.endpoint}\n`);
          break;
        }
        case "command":
          try { await exec(action.command, [...action.args], { maxBuffer: 1024 * 1024 }); }
          catch (error) { if (!action.ignoreFailure) throw error; }
          break;
        case "remove": await rm(action.path, { recursive: action.recursive, force: true }); break;
        case "remove-link": {
          const target = await host.readlink(action.path);
          if (target?.startsWith(`${action.prefix}/`)) await rm(action.path, { force: true });
          else if (target || await host.exists(action.path)) return `Retaining foreign command at ${action.path}${target ? ` -> ${target}` : ""}`;
          break;
        }
        case "restore-package-policy": return restoreHostPackagePolicy(action.stateDirectory, action.policy);
        case "purge-packages": {
          if (!await host.which("dpkg-query") || !await host.which("apt-get")) break;
          const packages: string[] = [];
          for (const name of ["zelavis"]) {
            try { if ((await exec("dpkg-query", ["-W", "-f=${db:Status-Abbrev}", name])).stdout.startsWith("ii")) packages.push(name); } catch {}
          }
          if (packages.length) await exec("apt-get", ["purge", "-y", ...packages], { env: { ...process.env, DEBIAN_FRONTEND: "noninteractive" } });
          break;
        }
        case "claim-edge": await claimLocalEdgeOwner(action); break;
        case "release-edge": await releaseLocalEdgeOwner(action); break;
        case "remove-account": {
          const account = action.account ?? "zelavis";
          if (!await host.which("getent")) break;
          const messages: string[] = [];
          if (await host.accountExists("user", account)) {
            const fields = (await exec("getent", ["passwd", account])).stdout.trim().split(":");
            if (action.ownsUser && fields[5] === action.dataDirectory && /\/(?:nologin|false)$/u.test(fields[6] ?? "")) {
              try { await exec("userdel", [account]); } catch { messages.push(`Retaining ${account} account: userdel failed.`); }
            } else messages.push(`Retaining ${account} account: ownership or current properties do not prove a dedicated installer account.`);
          }
          if (await host.accountExists("group", account)) {
            if (action.ownsGroup) {
              try { await exec("groupdel", [account]); } catch { messages.push(`Retaining ${account} group because another account still uses it.`); }
            } else messages.push(`Retaining ${account} group: the installer did not record creating it.`);
          }
          return messages.join("\n") || undefined;
        }
      }
      return undefined;
    },
  };
  return host;
}
