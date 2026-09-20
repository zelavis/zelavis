import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  assertCompleteUninstallConfirmation,
  type ZelavisInstallationIdentity,
  type ZelavisInstallationRemovalTarget,
  type ZelavisInstallationUninstaller,
} from "../core/runtime/installation.js";

const execFileAsync = promisify(execFile);

const RETAINED_HOST_STATE = Object.freeze([
  "Ubuntu packages such as nginx, PHP and MariaDB that may be shared with non-Zelavis workloads",
  "systemd journal history, which cannot be erased per application without affecting shared logs",
  "manually downloaded release archives and operator-managed backups",
  "operator-managed reverse-proxy, firewall, DNS and TLS configuration",
]);

const UNSAFE_OWNED_TREE_ROOTS = new Set([
  "/",
  "/Applications",
  "/Library",
  "/System",
  "/Users",
  "/bin",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/media",
  "/mnt",
  "/opt",
  "/private",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/srv",
  "/sys",
  "/tmp",
  "/usr",
  "/var",
]);

function assertSafeOwnedTree(path: string, label: string): string {
  const absolute = resolve(path);
  if (
    !isAbsolute(path) ||
    UNSAFE_OWNED_TREE_ROOTS.has(absolute)
  ) {
    throw new TypeError(
      `Refusing to use unsafe ${label} path "${path}" for complete uninstall.`,
    );
  }
  return absolute;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export interface NodeInstallationUninstallerOptions {
  readonly installation: ZelavisInstallationIdentity;
  /** Overrides the installer receipt, primarily for explicit operator recovery. */
  readonly dataDirectory?: string;
  /** Overrides the staged script location for tests or custom packaging. */
  readonly scriptPath?: string;
}

interface ZelavisNativeInstallationReceipt {
  readonly schemaVersion: 1;
  readonly dataDirectory: string;
  readonly commandPath: string;
  readonly ownsUser?: boolean;
  readonly ownsGroup?: boolean;
}

async function readInstallationReceipt(
  prefix: string,
): Promise<ZelavisNativeInstallationReceipt | undefined> {
  const path = join(prefix, "installation.json");
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Cannot read native installation receipt at ${path}.`, {
      cause: error,
    });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    typeof (value as { dataDirectory?: unknown }).dataDirectory !== "string" ||
    typeof (value as { commandPath?: unknown }).commandPath !== "string"
  ) {
    throw new Error(`Native installation receipt at ${path} is malformed.`);
  }
  return value as ZelavisNativeInstallationReceipt;
}

/** Native Node-host implementation of the complete installation-removal API. */
export function createNodeInstallationUninstaller(
  options: NodeInstallationUninstallerOptions,
): ZelavisInstallationUninstaller {
  if (options.installation.kind !== "packaged" || !options.installation.root) {
    throw new TypeError(
      "Complete host uninstall is available only to a packaged Zelavis installation. Use the package manager that installed npm or source copies.",
    );
  }

  const prefix = assertSafeOwnedTree(
    options.installation.root,
    "installation root",
  );
  if (!resolve(options.installation.path).startsWith(`${prefix}/`)) {
    throw new TypeError(
      `The running Zelavis CLI is outside the packaged installation root "${prefix}".`,
    );
  }
  const scriptPath = resolve(
    options.scriptPath ?? join(prefix, "current", "share", "uninstall.sh"),
  );
  if (!scriptPath.startsWith(`${prefix}/`)) {
    throw new TypeError(
      `The complete-uninstall program must be inside the packaged installation root "${prefix}".`,
    );
  }

  const resolveOwnedState = async () => {
    const receipt = await readInstallationReceipt(prefix);
    const dataDirectory = assertSafeOwnedTree(
      options.dataDirectory ?? receipt?.dataDirectory ?? "/var/lib/zelavis",
      "data directory",
    );
    const recordedCommandPath = receipt?.commandPath ?? "/usr/local/bin/zelavis";
    if (!isAbsolute(recordedCommandPath)) {
      throw new TypeError(
        `Refusing non-absolute command path "${recordedCommandPath}" from the native installation receipt.`,
      );
    }
    if (basename(recordedCommandPath) !== "zelavis") {
      throw new TypeError(
        `Refusing command path "${recordedCommandPath}" because a native Zelavis command must be named "zelavis".`,
      );
    }
    return {
      dataDirectory,
      commandPath: resolve(recordedCommandPath),
      ownsUser: receipt?.ownsUser === true,
      ownsGroup: receipt?.ownsGroup === true,
    };
  };

  const targetDefinitions = (
    dataDirectory: string,
    commandPath: string,
    ownsUser: boolean,
    ownsGroup: boolean,
  ): readonly Omit<
    ZelavisInstallationRemovalTarget,
    "exists"
  >[] => [
    {
      id: "services",
      kind: "service",
      description:
        "Stop, disable and remove the Zelavis Platform and Agent systemd units.",
    },
    {
      id: "packages",
      kind: "package",
      description:
        "Purge the zelavis and zelavis-repository Debian package records when present.",
    },
    {
      id: "commands",
      kind: "command",
      description:
        "Remove the recorded Zelavis command link without touching a foreign npm or source command.",
      path: commandPath,
    },
    ...(commandPath === "/usr/bin/zelavis"
      ? []
      : [{
          id: "system-command",
          kind: "command" as const,
          description:
            "Remove /usr/bin/zelavis only when it points into this packaged installation.",
          path: "/usr/bin/zelavis",
        }]),
    {
      id: "installation",
      kind: "directory",
      description:
        "Remove all installed Zelavis releases and the current release pointer.",
      path: prefix,
    },
    {
      id: "data",
      kind: "directory",
      description:
        "Remove Platform state, Projects, databases, logs, sockets and Agent state.",
      path: dataDirectory,
    },
    {
      id: "configuration",
      kind: "configuration",
      description:
        "Remove /etc/zelavis, including operation trust and local service configuration.",
      path: "/etc/zelavis",
    },
    {
      id: "repository-source",
      kind: "repository",
      description: "Remove the Zelavis APT source when present.",
      path: "/etc/apt/sources.list.d/zelavis.sources",
    },
    {
      id: "repository-key",
      kind: "repository",
      description: "Remove the Zelavis APT archive signing key when present.",
      path: "/usr/share/keyrings/zelavis-archive-keyring.gpg",
    },
    {
      id: "account",
      kind: "account",
      description:
        `Remove the zelavis system user/group only when installer ownership was recorded (user: ${ownsUser}, group: ${ownsGroup}) and current properties remain safe.`,
    },
  ];

  return {
    async plan() {
      if (!(await pathExists(scriptPath))) {
        throw new Error(
          `This packaged release does not contain its complete-uninstall program at ${scriptPath}.`,
        );
      }
      const { dataDirectory, commandPath, ownsUser, ownsGroup } =
        await resolveOwnedState();
      const targets = await Promise.all(
        targetDefinitions(
          dataDirectory,
          commandPath,
          ownsUser,
          ownsGroup,
        ).map(async (target) => ({
          ...target,
          ...(target.path ? { exists: await pathExists(target.path) } : {}),
        })),
      );
      return {
        adapter: "node",
        installation: options.installation,
        dataDirectory,
        targets,
        retained: RETAINED_HOST_STATE,
      };
    },
    async uninstall(input) {
      assertCompleteUninstallConfirmation(input.confirmation);
      const plan = await this.plan();
      const { commandPath, ownsUser, ownsGroup } = await resolveOwnedState();
      const { stdout, stderr } = await execFileAsync(
        "/bin/sh",
        [scriptPath, "--confirm", input.confirmation],
        {
          env: {
            ...process.env,
            ZELAVIS_PREFIX: prefix,
            ZELAVIS_DATA_DIR: plan.dataDirectory,
            ZELAVIS_UNINSTALL_ETC_DIR: "/etc/zelavis",
            ZELAVIS_BIN_DIR: dirname(commandPath),
            ZELAVIS_UNINSTALL_COMMAND: commandPath,
            ZELAVIS_UNINSTALL_SYSTEM_BIN: "/usr/bin/zelavis",
            ZELAVIS_UNINSTALL_SYSTEMD_ETC_DIR: "/etc/systemd/system",
            ZELAVIS_UNINSTALL_SYSTEMD_LIB_DIR: "/lib/systemd/system",
            ZELAVIS_UNINSTALL_SYSTEMD_USR_LIB_DIR: "/usr/lib/systemd/system",
            ZELAVIS_UNINSTALL_APT_SOURCE:
              "/etc/apt/sources.list.d/zelavis.sources",
            ZELAVIS_UNINSTALL_APT_KEYRING:
              "/usr/share/keyrings/zelavis-archive-keyring.gpg",
            ZELAVIS_UNINSTALL_OWNS_USER: ownsUser ? "1" : "0",
            ZELAVIS_UNINSTALL_OWNS_GROUP: ownsGroup ? "1" : "0",
            ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS: "0",
          },
          maxBuffer: 1024 * 1024,
        },
      );
      const output = `${stdout}${stderr}`.trim();
      return {
        removed: true,
        plan,
        ...(output ? { output } : {}),
      };
    },
  };
}
