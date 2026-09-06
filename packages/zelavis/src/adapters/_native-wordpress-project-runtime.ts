import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type {
  ZelavisAgentProcess,
  ZelavisAgentProcessRunner,
} from "../core/agent/process-command.js";
import {
  ZelavisProjectRuntimeError,
  type ZelavisProjectRecipeLock,
  type ZelavisProjectLogEntry,
  type ZelavisProjectRecord,
  type ZelavisProjectRuntimeDriver,
} from "../project.js";
/*
 * Keep host executables shared while every Project owns its service processes,
 * configuration, sockets, ports, logs, credentials, site files, and data.
 */

export interface NativeWordPressProjectRuntimeOptions {
  directory: string;
  startupTimeoutMs?: number;
  /**
   * Unprivileged account the daemons run as when the Platform runs as root.
   *
   * Ignored otherwise: a Platform that is already unprivileged runs its
   * Project's daemons as itself, which is what happens today.
   *
   * One account for all three daemons rather than the conventional split of
   * `mysql` and `www-data`. They serve a single Project and share its files, so
   * one identity keeps ownership coherent — and it is the shape per-Project
   * Unix identities will need, rather than something to undo on the way there.
   */
  user?: string;
  /**
   * Agent that executes nginx, php-fpm, and the database.
   *
   * Defaults to the local runner. Three supervised processes rather than one,
   * all issued as the same command through the same contract.
   */
  agent?: ZelavisAgentProcessRunner;
}

interface NativeWordPressConfig {
  nginx: string;
  php: string;
  phpFpm: string;
  mariadbd: string;
  mariadbInstallDb: string;
  mariadbClient: string;
  httpPort: number;
  databasePort: number;
  databaseName: string;
  databaseUser: string;
  databasePassword: string;
  socketId: string;
  databaseInitialized: boolean;
}

interface NativeWordPressProcesses {
  database?: ZelavisAgentProcess;
  nginx?: ZelavisAgentProcess;
  phpFpm?: ZelavisAgentProcess;
  logs: ZelavisProjectLogEntry[];
}

interface NativeWordPressExecutables {
  nginx: string;
  php: string;
  phpFpm: string;
  mariadbd: string;
  mariadbInstallDb: string;
  mariadbClient: string;
}

const WORDPRESS_APP_NAME = "zelavis/wordpress";
const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const LOG_LIMIT = 500;
const MAX_WORDPRESS_ARCHIVE_BYTES = 64 * 1024 * 1024;
const APT_WORDPRESS_PACKAGES = Object.freeze([
  "nginx",
  "php-fpm",
  "php-cli",
  "php-mysql",
  "php-curl",
  "php-gd",
  "php-intl",
  "php-mbstring",
  "php-xml",
  "php-zip",
  "mariadb-server-core",
  "mariadb-client-core",
]);
const BREW_WORDPRESS_PACKAGES = Object.freeze(["nginx", "php", "mariadb"]);

/**
 * Environment handed to a native process this driver starts.
 *
 * Both the supervised daemons and the one-shot setup commands get this, and
 * neither gets the Platform's own environment: inheriting `process.env` would
 * hand a Project's web server — and every `tar`, `php`, and MariaDB invocation
 * beside it — the control plane's bootstrap token, provider credentials, and
 * signing keys.
 *
 * `HOME` is forwarded because the MariaDB tools need somewhere to write and
 * read their option files, and a missing `HOME` makes them fail in ways that
 * read as a database problem rather than a configuration one. The one class of
 * command that genuinely needs more is host package installation, which opts
 * in explicitly.
 */
function nativeProcessEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

/**
 * The account the daemons drop to, when the Platform is root.
 *
 * MariaDB refuses to start as root at all unless it is told which user to
 * become — "Please consult the Knowledge Base to find out how to run mysqld as
 * root!" — and installing only `mariadb-server-core` leaves no `mysql` account
 * to name. Without this a root Platform installs its packages successfully and
 * then dies at the first port wait, which reads as a provisioning failure and
 * is not one.
 *
 * Returns undefined when the Platform is not root, which is the ordinary case:
 * the daemons run as whoever started the Platform.
 */
async function resolveRuntimeAccount(
  configured: string | undefined,
): Promise<{ name: string; group: string; uid: number; gid: number } | undefined> {
  if (process.getuid?.() !== 0) return undefined;

  // A configured account is used or refused; it is not quietly replaced with a
  // fallback, because an operator who named one is describing their host.
  const candidates = configured ? [configured] : ["www-data", "mysql", "nobody"];

  for (const name of candidates) {
    const uid = await run("id", ["-u", name], { allowFailure: true });
    const gid = await run("id", ["-g", name], { allowFailure: true });
    // The group's name, not the user's. They coincide on Debian and do not on
    // macOS, and PHP-FPM wants the name.
    const group = await run("id", ["-gn", name], { allowFailure: true });
    if (uid.code === 0 && gid.code === 0 && group.code === 0) {
      return {
        name,
        group: group.stdout.trim(),
        uid: Number(uid.stdout.trim()),
        gid: Number(gid.stdout.trim()),
      };
    }
  }

  throw new ZelavisProjectRuntimeError(
    configured
      ? `Native WordPress is configured to run as "${configured}", but no such account exists on this host.`
      : "Native WordPress is running as root and found no unprivileged account to run its daemons as. " +
          "MariaDB will not start as root. Create one of www-data, mysql or nobody, name one with the " +
          "WordPress runtime's `user` option, or run Zelavis as an ordinary user with package authority.",
  );
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function run(
  executable: string,
  args: readonly string[],
  options: {
    cwd?: string;
    allowFailure?: boolean;
    /**
     * Run with the Platform's own environment.
     *
     * Only for host package managers. `brew` and `apt` are configured through
     * environment variables an operator sets — a prefix, a mirror, a proxy, a
     * non-interactive flag — and stripping those turns "install the packages
     * this host needs" into a failure the operator cannot explain. They also
     * run as the operator provisioning their own machine, not as Project code,
     * which is the distinction that makes this safe where it would not be for
     * anything a Project can influence.
     */
    inheritEnvironment?: boolean;
  } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.inheritEnvironment
        ? { ...process.env }
        : nativeProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => rejectRun(new Error(
      `Required native executable "${executable}" is unavailable.`, { cause: error },
    )));
    child.once("exit", (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        rejectRun(new Error(`${executable} failed: ${(stderr || stdout).trim() || `exit ${exitCode}`}`));
        return;
      }
      resolveRun({ code: exitCode, stdout, stderr });
    });
  });
}

async function resolveExecutable(
  candidates: readonly string[],
  versionArgs: readonly string[] = ["--version"],
  displayName = candidates.join(" or "),
  acceptProbeFailure = false,
): Promise<string> {
  for (const candidate of candidates) {
    try {
      const probe = await run(candidate, versionArgs, { allowFailure: true });
      if (acceptProbeFailure || probe.code === 0) return candidate;
    } catch {
      // Try the next conventional executable name.
    }
  }
  throw new ZelavisProjectRuntimeError(
    `Native WordPress requires ${displayName}, but Zelavis could not find it on this host.`,
  );
}

async function executableAvailable(executable: string): Promise<boolean> {
  try {
    // `brew` is one of the executables probed here and reports its version
    // from its own installation, which it locates through its environment.
    return (
      await run(executable, ["--version"], {
        allowFailure: true,
        inheritEnvironment: true,
      })
    ).code === 0;
  } catch {
    return false;
  }
}

async function provisionNativeWordPressPackages(): Promise<void> {
  if (process.platform === "linux" && await executableAvailable("apt-get")) {
    const apt = process.getuid?.() === 0
      ? { executable: "apt-get", prefix: [] as string[] }
      : await executableAvailable("sudo") &&
          (await run("sudo", ["-n", "true"], { allowFailure: true, inheritEnvironment: true })).code === 0
        ? { executable: "sudo", prefix: ["-n", "apt-get"] }
        : undefined;
    if (!apt) {
      throw new ZelavisProjectRuntimeError(
        "Native WordPress packages are missing and Zelavis cannot invoke apt with host-package authority. Install the Zelavis Debian package, run Zelavis as root for first provisioning, or grant its host Agent passwordless package installation.",
      );
    }
    try {
      await run(apt.executable, [...apt.prefix, "update"], { inheritEnvironment: true });
      await run(
        apt.executable,
        [
          ...apt.prefix,
          "install",
          "-y",
          "--no-install-recommends",
          ...APT_WORDPRESS_PACKAGES,
        ],
        { inheritEnvironment: true },
      );
    } catch (cause) {
      throw new ZelavisProjectRuntimeError(
        "Zelavis could not install the native WordPress dependencies through APT. Check the host package repositories and Agent package-install permissions.",
        { cause },
      );
    }
    return;
  }

  if (process.platform === "darwin" && await executableAvailable("brew")) {
    try {
      await run("brew", ["install", ...BREW_WORDPRESS_PACKAGES], {
        inheritEnvironment: true,
      });
    } catch (cause) {
      throw new ZelavisProjectRuntimeError(
        "Zelavis could not install the native WordPress dependencies through Homebrew. Check the Homebrew installation and retry the Project start.",
        { cause },
      );
    }
    return;
  }

  throw new ZelavisProjectRuntimeError(
    "Native WordPress requires a supported host package provider (APT on Debian/Ubuntu or Homebrew on macOS).",
  );
}

async function brewFormulaExecutable(
  formula: string,
  relativePath: string,
): Promise<string | undefined> {
  if (process.platform !== "darwin" || !await executableAvailable("brew")) {
    return undefined;
  }
  // Homebrew resolves its own prefix from its environment, so asking it where
  // a formula lives is one of the calls that needs that environment.
  const prefix = await run("brew", ["--prefix", formula], {
    allowFailure: true,
    inheritEnvironment: true,
  });
  const directory = prefix.stdout.trim();
  return prefix.code === 0 && directory ? join(directory, relativePath) : undefined;
}

async function resolveNativeWordPressExecutables(): Promise<NativeWordPressExecutables> {
  const resolveAll = async (): Promise<NativeWordPressExecutables> => {
    const [brewNginx, brewPhp, brewPhpFpm, brewMariadbd, brewInstallDb, brewClient] =
      await Promise.all([
        brewFormulaExecutable("nginx", "bin/nginx"),
        brewFormulaExecutable("php", "bin/php"),
        brewFormulaExecutable("php", "sbin/php-fpm"),
        brewFormulaExecutable("mariadb", "bin/mariadbd"),
        brewFormulaExecutable("mariadb", "bin/mariadb-install-db"),
        brewFormulaExecutable("mariadb", "bin/mariadb"),
      ]);
    return {
      nginx: await resolveExecutable(
        ["nginx", ...(brewNginx ? [brewNginx] : [])],
        ["-v"],
        "Nginx",
      ),
      php: await resolveExecutable(
        ["php", ...(brewPhp ? [brewPhp] : [])],
        ["--version"],
        "PHP CLI",
      ),
      phpFpm: await resolveExecutable([
        "php-fpm",
        "php-fpm8.5",
        "php-fpm8.4",
        "php-fpm8.3",
        "php-fpm8.2",
        ...(brewPhpFpm ? [brewPhpFpm] : []),
      ], ["-v"], "PHP-FPM"),
      mariadbd: await resolveExecutable(
        ["mariadbd", ...(brewMariadbd ? [brewMariadbd] : [])],
        ["--version"],
        "MariaDB Server",
      ),
      mariadbInstallDb: await resolveExecutable(
        ["mariadb-install-db", ...(brewInstallDb ? [brewInstallDb] : [])],
        ["--help"],
        "MariaDB database initialization tools",
        true,
      ),
      mariadbClient: await resolveExecutable(
        ["mariadb", ...(brewClient ? [brewClient] : [])],
        ["--version"],
        "MariaDB Client",
      ),
    };
  };

  try {
    return await resolveAll();
  } catch {
    await provisionNativeWordPressPackages();
    return resolveAll();
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPort(new Error("Could not allocate a native WordPress port."));
        return;
      }
      server.close((error) => error ? rejectPort(error) : resolvePort(address.port));
    });
  });
}

/**
 * Waits for a port to accept connections, and for the right reason.
 *
 * `isRunning` is not optional decoration. A port accepting connections proves
 * something is listening, not that it is the process just started — and this
 * driver reuses a persisted port, so a stale listener left by a crashed
 * Platform makes the check pass immediately. That was the observed failure: a
 * Project reported running while its new nginx logged
 * `bind() ... Address already in use` and traffic went to the old process.
 * Reclamation clears the leftover first; this makes the wait tell the truth
 * even if one is ever missed.
 */
async function waitForPort(
  port: number,
  timeoutMs: number,
  isRunning?: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRunning && !isRunning()) {
      throw new Error(
        `Native service for port ${port} exited before it began listening.`,
      );
    }
    const connected = await new Promise<boolean>((resolveConnection) => {
      const socket = new Socket();
      socket.setTimeout(1_000);
      socket.once("connect", () => { socket.destroy(); resolveConnection(true); });
      socket.once("error", () => { socket.destroy(); resolveConnection(false); });
      socket.once("timeout", () => { socket.destroy(); resolveConnection(false); });
      socket.connect(port, "127.0.0.1");
    });
    if (connected) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Native service on port ${port} did not become ready.`);
}

async function waitForPath(
  path: string,
  timeoutMs: number,
  isRunning?: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRunning && !isRunning()) {
      throw new Error(`Native service exited before creating ${path}.`);
    }
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw new Error(`Native service did not create ${path}.`);
}

function phpString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function sqlIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/i.test(value)) throw new Error("Unsafe generated database identifier.");
  return `\`${value}\``;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function versionAtLeast(actual: string, minimum: readonly [number, number]): boolean {
  const match = actual.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

function wordpressConfig(config: NativeWordPressConfig): string {
  const salts = Array.from({ length: 8 }, () => randomBytes(48).toString("base64url"));
  const saltNames = [
    "AUTH_KEY", "SECURE_AUTH_KEY", "LOGGED_IN_KEY", "NONCE_KEY",
    "AUTH_SALT", "SECURE_AUTH_SALT", "LOGGED_IN_SALT", "NONCE_SALT",
  ];
  return `<?php
define('DB_NAME', '${phpString(config.databaseName)}');
define('DB_USER', '${phpString(config.databaseUser)}');
define('DB_PASSWORD', '${phpString(config.databasePassword)}');
define('DB_HOST', '127.0.0.1:${config.databasePort}');
define('DB_CHARSET', 'utf8mb4');
define('DB_COLLATE', '');
${saltNames.map((name, index) => `define('${name}', '${salts[index]}');`).join("\n")}
$table_prefix = 'wp_';
define('WP_DEBUG', false);
if (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');
require_once ABSPATH . 'wp-settings.php';
`;
}

function nginxQuoted(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function phpFpmConfig(input: {
  runtimeDirectory: string;
  socketDirectory: string;
  siteDirectory: string;
  username: string;
  /**
   * The account's actual primary group, which is not its username.
   *
   * On Debian `www-data` belongs to `www-data` and the two are
   * interchangeable; on macOS an ordinary user belongs to `staff`. Assuming
   * they match made PHP-FPM refuse to start with "cannot get gid for group",
   * on every Mac, for as long as nobody ran WordPress on one.
   */
  group: string;
}): string {
  for (const value of [input.username, input.group]) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(value)) {
      throw new Error("The native host account cannot be represented in PHP-FPM configuration.");
    }
  }
  return `[global]
pid = ${input.runtimeDirectory}/php-fpm.pid
error_log = ${input.runtimeDirectory}/php-fpm.log
daemonize = no

[wordpress]
user = ${input.username}
group = ${input.group}
listen = ${input.socketDirectory}/php-fpm.sock
; The socket is created by the PHP-FPM master, which is still root when the
; Platform is. Without these it lands root-owned and nginx's workers — which
; dropped to the same unprivileged account the pool did — get a 502 connecting
; to a socket they cannot open. Comments here are ";", not "#": PHP-FPM parses
; this with the INI parser, which rejects a "#" line as a null entry.
listen.owner = ${input.username}
listen.group = ${input.group}
listen.mode = 0600
pm = dynamic
pm.max_children = 8
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 500
chdir = ${input.siteDirectory}
catch_workers_output = yes
clear_env = yes
security.limit_extensions = .php
php_admin_value[upload_tmp_dir] = ${input.runtimeDirectory}/tmp
php_admin_value[session.save_path] = ${input.runtimeDirectory}/sessions
php_admin_value[error_log] = ${input.runtimeDirectory}/php-errors.log
php_admin_flag[log_errors] = on
`;
}

function nginxConfig(input: {
  httpPort: number;
  runtimeDirectory: string;
  socketDirectory: string;
  siteDirectory: string;
  /** Set only when the Platform is root; nginx workers drop to it. */
  runAs?: string;
}): string {
  const site = nginxQuoted(input.siteDirectory);
  const phpSocket = `unix:${input.socketDirectory}/php-fpm.sock`;
  // Without this an nginx started by root runs its workers as `nobody`, which
  // cannot read a Project directory owned by anyone else. Set only when root:
  // an unprivileged nginx cannot switch user and warns about the directive.
  return `${input.runAs ? `user ${input.runAs};\n` : ""}pid ${nginxQuoted(join(input.runtimeDirectory, "nginx.pid"))};
error_log stderr notice;

events { worker_connections 1024; }

http {
  access_log ${nginxQuoted(join(input.runtimeDirectory, "nginx-access.log"))};
  error_log ${nginxQuoted(join(input.runtimeDirectory, "nginx-error.log"))};
  # Every temp path nginx may create, not only the ones this config uses.
  # A path left unset falls back to the prefix nginx was compiled with —
  # /var/lib/nginx on Debian — which the Platform's user cannot write, and
  # nginx creates the directory for every module it was built with whether the
  # config mentions it or not. Homebrew's nginx hid this by defaulting to a
  # prefix the user owns, so it only appeared on Linux.
  client_body_temp_path ${nginxQuoted(join(input.runtimeDirectory, "nginx-client-temp"))};
  proxy_temp_path ${nginxQuoted(join(input.runtimeDirectory, "nginx-proxy-temp"))};
  fastcgi_temp_path ${nginxQuoted(join(input.runtimeDirectory, "nginx-fastcgi-temp"))};
  uwsgi_temp_path ${nginxQuoted(join(input.runtimeDirectory, "nginx-uwsgi-temp"))};
  scgi_temp_path ${nginxQuoted(join(input.runtimeDirectory, "nginx-scgi-temp"))};
  default_type application/octet-stream;
  types {
    text/html html htm;
    text/css css;
    application/javascript js;
    application/json json;
    application/pdf pdf;
    application/zip zip;
    image/gif gif;
    image/jpeg jpg jpeg;
    image/png png;
    image/svg+xml svg;
    image/webp webp;
    font/woff woff;
    font/woff2 woff2;
    audio/mpeg mp3;
    video/mp4 mp4;
  }
  sendfile on;
  client_max_body_size 64m;

  server {
    listen 127.0.0.1:${input.httpPort};
    server_name _;
    root ${site};
    index index.php index.html;

    location / {
      try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
      try_files $uri =404;
      fastcgi_pass ${phpSocket};
      fastcgi_index index.php;
      fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
      fastcgi_param SCRIPT_NAME $fastcgi_script_name;
      fastcgi_param QUERY_STRING $query_string;
      fastcgi_param REQUEST_METHOD $request_method;
      fastcgi_param CONTENT_TYPE $content_type;
      fastcgi_param CONTENT_LENGTH $content_length;
      fastcgi_param REQUEST_URI $request_uri;
      fastcgi_param DOCUMENT_URI $document_uri;
      fastcgi_param DOCUMENT_ROOT $document_root;
      fastcgi_param SERVER_PROTOCOL $server_protocol;
      fastcgi_param REQUEST_SCHEME $scheme;
      fastcgi_param HTTPS $https if_not_empty;
      fastcgi_param GATEWAY_INTERFACE CGI/1.1;
      fastcgi_param SERVER_SOFTWARE nginx;
      fastcgi_param REMOTE_ADDR $remote_addr;
      fastcgi_param REMOTE_PORT $remote_port;
      fastcgi_param SERVER_ADDR $server_addr;
      fastcgi_param SERVER_PORT $server_port;
      fastcgi_param SERVER_NAME $server_name;
      fastcgi_param REDIRECT_STATUS 200;
      fastcgi_param HTTP_PROXY "";
    }

    location ~ /\\.(?!well-known/) { deny all; }
  }
}
`;
}

export function createNativeWordPressProjectRuntime(
  options: NativeWordPressProjectRuntimeOptions,
): ZelavisProjectRuntimeDriver {
  const projectsDirectory = resolve(options.directory);
  const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const processes = new Map<string, NativeWordPressProcesses>();
  const agent =
    options.agent ??
    createLocalAgentProcessRunner({
      stateDirectory: join(projectsDirectory, ".agent-processes"),
    });
  let runtimeAccount: Awaited<ReturnType<typeof resolveRuntimeAccount>> | undefined;
  let runtimeAccountResolved = false;

  async function account() {
    if (!runtimeAccountResolved) {
      runtimeAccount = await resolveRuntimeAccount(options.user);
      runtimeAccountResolved = true;
    }
    return runtimeAccount;
  }

  /**
   * Hands a path to the account the daemons run as.
   *
   * A no-op unless the Platform is root. The daemons cannot write a data
   * directory, a socket directory or a site they do not own, and they are no
   * longer the same user as the Platform that created those.
   */
  /**
   * The primary group of whoever is running the Platform.
   *
   * `os.userInfo()` reports a gid but no group name, and PHP-FPM's `group`
   * directive wants the name.
   */
  async function currentGroupName(): Promise<string> {
    const group = await run("id", ["-gn"], { allowFailure: true });
    const name = group.stdout.trim();
    return group.code === 0 && name ? name : userInfo().username;
  }

  async function handOver(path: string) {
    const owner = await account();
    if (!owner) return;
    // Not `allowFailure`. A silent chown failure surfaces later as MariaDB
    // being unable to write its own data directory, which reads as a database
    // problem and is a permissions one.
    await run("chown", ["-R", `${owner.uid}:${owner.gid}`, path]);
    await ensureTraversable(dirname(path), owner);
  }

  /**
   * Lets the account reach a directory it owns.
   *
   * Owning the Project directory is not enough: every directory above it has to
   * be traversable, and the Platform's data directory is created 0700 by the
   * user that created it — root. Without this the daemons drop to an account
   * that cannot walk to the files it owns, and MariaDB reports "Can't
   * create/write to file ... Permission denied" on a directory that is
   * unambiguously its own.
   *
   * Adds the execute bit only, never read. A directory that is traversable but
   * not readable can be walked through by someone who already knows the path
   * and cannot be listed, so this does not expose the System Store or anything
   * else living beside the Projects — those keep their own modes. It stops at
   * the first directory the Platform does not own, because widening something
   * the operator set up is not this driver's business.
   */
  async function ensureTraversable(
    from: string,
    owner: { uid: number; gid: number },
  ): Promise<void> {
    let current = resolve(from);

    while (true) {
      const info = await stat(current).catch(() => undefined);
      if (!info) return;

      const alreadyOwned = info.uid === owner.uid;
      const traversable = alreadyOwned || (info.mode & 0o001) !== 0;
      if (!traversable) {
        if (info.uid !== process.getuid?.()) return;
        await chmod(current, info.mode | 0o001).catch(() => undefined);
      }

      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  }

  const projectDirectory = (id: string) => join(projectsDirectory, id);
  const runtimeDirectory = (id: string) => join(projectDirectory(id), ".zelavis");
  const configPath = (id: string) => join(runtimeDirectory(id), "wordpress-native.json");
  const siteDirectory = (id: string) => join(runtimeDirectory(id), "wordpress");
  const databaseDirectory = (id: string) => join(runtimeDirectory(id), "mariadb");
  const socketDirectory = (config: NativeWordPressConfig) =>
    join("/tmp", `zv-wp-${config.socketId}`);

  async function readConfig(projectId: string): Promise<NativeWordPressConfig> {
    return JSON.parse(await readFile(configPath(projectId), "utf8")) as NativeWordPressConfig;
  }

  function appendLog(projectId: string, stream: ZelavisProjectLogEntry["stream"], message: string) {
    const state = processes.get(projectId) ?? { logs: [] };
    for (const line of message.split("\n").filter(Boolean)) {
      state.logs.push({ timestamp: new Date().toISOString(), stream, message: line });
    }
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT);
    processes.set(projectId, state);
  }

  /** Labels a process's output, so three of them share one Project log. */
  function capture(projectId: string, label: string) {
    return ({ stream, line }: { stream: "stdout" | "stderr"; line: string }) =>
      appendLog(projectId, stream, `[${label}] ${line}`);
  }

  const capabilities = Object.freeze({
    independentRuntimeVersion: true,
    movable: false,
    liveMigration: false,
    secureIsolation: false,
    resourceLimits: false,
    persistentFilesystem: true,
    statelessRuntimeReplicas: false,
    managedStorage: true,
    managedDatabase: true,
    databaseReplication: false,
    tenantPlacement: false,
    databaseSharding: false,
    runtimeOwnership: "platform-process" as const,
    survivesControlPlaneRestart: false,
    description:
      "Runs a version-pinned WordPress release with dedicated native Nginx, PHP-FPM, and MariaDB processes, configuration, sockets, logs, and data directories.",
  });

  const driver: ZelavisProjectRuntimeDriver = {
    name: "native-wordpress",
    runtimeKinds: Object.freeze(["native"]),
    defaultRuntimeKind: "native",
    startupConcurrency: 1,
    capabilities: () => capabilities,
    async prepare(project: ZelavisProjectRecord, recipe: ZelavisProjectRecipeLock) {
      if (recipe.name !== WORDPRESS_APP_NAME) throw new Error(`Unsupported native WordPress recipe "${recipe.name}".`);
      await mkdir(siteDirectory(project.id), { recursive: true, mode: 0o700 });
      await mkdir(databaseDirectory(project.id), { recursive: true, mode: 0o700 });
      for (const name of [
        "tmp",
        "sessions",
        "nginx-client-temp",
        "nginx-proxy-temp",
        "nginx-fastcgi-temp",
        "nginx-uwsgi-temp",
        "nginx-scgi-temp",
      ]) {
        await mkdir(join(runtimeDirectory(project.id), name), {
          recursive: true,
          mode: 0o700,
        });
      }
      let storedConfig: NativeWordPressConfig | undefined;
      try {
        storedConfig = await readConfig(project.id);
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
      }
      const executables = await resolveNativeWordPressExecutables();
      const phpVersion = (
        await run(executables.php, ["-r", "echo PHP_VERSION;"])
      ).stdout.trim();
      const phpFpmVersionResult = await run(executables.phpFpm, ["-v"]);
      const phpFpmVersion = `${phpFpmVersionResult.stdout} ${phpFpmVersionResult.stderr}`;
      if (
        !versionAtLeast(phpVersion, [8, 2]) ||
        !versionAtLeast(phpFpmVersion, [8, 2])
      ) {
        throw new Error(
          `Native WordPress requires PHP CLI and PHP-FPM 8.2 or newer; found CLI ${phpVersion} and FPM ${phpFpmVersion.trim()}.`,
        );
      }
      const requiredExtensions = [
        "curl",
        "dom",
        "fileinfo",
        "gd",
        "intl",
        "mbstring",
        "mysqli",
        "openssl",
        "xml",
        "zip",
      ];
      const extensionCheck = await run(executables.php, [
        "-r",
        `$required=${JSON.stringify(requiredExtensions)}; echo json_encode(array_values(array_filter($required, fn($extension) => !extension_loaded($extension))));`,
      ]);
      const missingExtensions = JSON.parse(extensionCheck.stdout) as string[];
      if (missingExtensions.length > 0) {
        throw new Error(
          `Native WordPress is missing required PHP extensions: ${missingExtensions.join(", ")}.`,
        );
      }
      const mariadbVersionResult = await run(executables.mariadbd, [
        "--version",
      ]);
      const mariadbVersion = `${mariadbVersionResult.stdout} ${mariadbVersionResult.stderr}`;
      if (!versionAtLeast(mariadbVersion, [10, 6])) {
        throw new Error(
          `Native WordPress requires MariaDB 10.6 or newer; found ${mariadbVersion.trim()}.`,
        );
      }
      const httpPort = storedConfig?.httpPort ?? (await availablePort());
      let databasePort =
        storedConfig?.databasePort ?? (await availablePort());
      while (databasePort === httpPort) databasePort = await availablePort();
      const config: NativeWordPressConfig = {
        ...executables,
        httpPort,
        databasePort,
        databaseName: "wordpress",
        databaseUser: "wordpress",
        databasePassword:
          storedConfig?.databasePassword ??
          randomBytes(32).toString("base64url"),
        socketId:
          storedConfig?.socketId ?? randomBytes(12).toString("hex"),
        databaseInitialized: storedConfig?.databaseInitialized === true,
      };
      await writeFile(
        configPath(project.id),
        `${JSON.stringify(config, null, 2)}\n`,
        { mode: 0o600 },
      );
      await mkdir(socketDirectory(config), { recursive: true, mode: 0o700 });
      await handOver(socketDirectory(config));

      const phpFpmConfiguration = join(
        runtimeDirectory(project.id),
        "php-fpm.conf",
      );
      await writeFile(
        phpFpmConfiguration,
        phpFpmConfig({
          runtimeDirectory: runtimeDirectory(project.id),
          socketDirectory: socketDirectory(config),
          siteDirectory: siteDirectory(project.id),
          username: (await account())?.name ?? userInfo().username,
          group: (await account())?.group ?? (await currentGroupName()),
        }),
        { mode: 0o600 },
      );
      const nginxConfiguration = join(
        runtimeDirectory(project.id),
        "nginx.conf",
      );
      await writeFile(
        nginxConfiguration,
        nginxConfig({
          httpPort: config.httpPort,
          runtimeDirectory: runtimeDirectory(project.id),
          socketDirectory: socketDirectory(config),
          siteDirectory: siteDirectory(project.id),
          ...((await account()) ? { runAs: (await account())!.name } : {}),
        }),
        { mode: 0o600 },
      );
      await run(config.phpFpm, ["-tt", "-y", phpFpmConfiguration]);
      await run(config.nginx, [
        "-t",
        "-c",
        nginxConfiguration,
        "-p",
        runtimeDirectory(project.id),
      ]);

      try {
        await readFile(join(siteDirectory(project.id), "wp-includes", "version.php"));
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        const archive = join(runtimeDirectory(project.id), `wordpress-${recipe.version}.tar.gz`);
        if (!/^\d+\.\d+(?:\.\d+)?(?:[-a-zA-Z0-9.]*)?$/.test(recipe.version)) {
          throw new Error(`Invalid locked WordPress version "${recipe.version}".`);
        }
        const response = await fetch(`https://wordpress.org/wordpress-${recipe.version}.tar.gz`);
        if (!response.ok || !response.body) throw new Error(`WordPress download failed with HTTP ${response.status}.`);
        const declaredSize = Number(response.headers.get("content-length") ?? 0);
        if (declaredSize > MAX_WORDPRESS_ARCHIVE_BYTES) {
          throw new Error("WordPress release archive exceeds the provisioning size limit.");
        }
        const archiveBody = new Uint8Array(await response.arrayBuffer());
        if (archiveBody.byteLength > MAX_WORDPRESS_ARCHIVE_BYTES) {
          throw new Error("WordPress release archive exceeds the provisioning size limit.");
        }
        await writeFile(archive, archiveBody, { mode: 0o600 });
        const archiveEntries = (await run("tar", ["-tzf", archive])).stdout
          .split("\n")
          .filter(Boolean);
        if (archiveEntries.some((entry) => {
          const parts = entry.split("/");
          return parts[0] !== "wordpress" || parts.includes("..") || entry.startsWith("/");
        })) {
          throw new Error("WordPress release archive contains an unsafe path.");
        }
        await run("tar", ["-xzf", archive, "--strip-components=1", "-C", siteDirectory(project.id)]);
        await rm(archive, { force: true });
      }
      try {
        await readFile(join(siteDirectory(project.id), "wp-config.php"));
      } catch (error) {
        if (!isMissingFileError(error)) throw error;
        await writeFile(join(siteDirectory(project.id), "wp-config.php"), wordpressConfig(config), { mode: 0o600 });
      }
      await writeFile(
        join(projectDirectory(project.id), "project.json"),
        `${JSON.stringify({ ...project, recipe, runtime: { driver: driver.name, capabilities } }, null, 2)}\n`,
        { mode: 0o600 },
      );

      // Last, once every file exists. Handing the tree over earlier would leave
      // whatever `prepare` wrote afterwards — the generated wp-config.php among
      // it — owned by the Platform and unreadable to the daemons.
      await handOver(projectDirectory(project.id));
    },
    async start(project) {
      const config = await readConfig(project.id);
      const state = processes.get(project.id) ?? { logs: [] };
      processes.set(project.id, state);
      try {
        if (!config.databaseInitialized) {
          const installAs = await account();
          await run(config.mariadbInstallDb, [
            `--datadir=${databaseDirectory(project.id)}`,
            "--auth-root-authentication-method=normal",
            "--skip-test-db",
            ...(installAs ? [`--user=${installAs.name}`] : []),
          ]);
        }
        if (!state.database?.running) {
          state.database = await agent.start(
            {
              workloadId: project.id,
              executable: config.mariadbd,
              args: [
                `--datadir=${databaseDirectory(project.id)}`,
                `--socket=${join(socketDirectory(config), "mariadb.sock")}`,
                `--port=${config.databasePort}`,
                "--bind-address=127.0.0.1",
                `--pid-file=${join(runtimeDirectory(project.id), "mariadb.pid")}`,
                `--log-error=${join(runtimeDirectory(project.id), "mariadb.log")}`,
                // MariaDB refuses to run as root without this, and there is
                // nothing sensible for it to guess.
                ...((await account()) ? [`--user=${(await account())!.name}`] : []),
              ],
              cwd: runtimeDirectory(project.id),
              env: nativeProcessEnvironment(),
            },
            { onOutput: capture(project.id, "mariadb") },
          );
        }
        await waitForPort(
          config.databasePort,
          startupTimeoutMs,
          () => state.database?.running !== false,
        );
        if (!config.databaseInitialized) {
          const socket = join(socketDirectory(config), "mariadb.sock");
          const sql = [
            `CREATE DATABASE IF NOT EXISTS ${sqlIdentifier(config.databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
            `CREATE USER IF NOT EXISTS ${sqlString(config.databaseUser)}@'127.0.0.1' IDENTIFIED BY ${sqlString(config.databasePassword)}`,
            `GRANT ALL PRIVILEGES ON ${sqlIdentifier(config.databaseName)}.* TO ${sqlString(config.databaseUser)}@'127.0.0.1'`,
            "FLUSH PRIVILEGES",
          ].join("; ");
          await run(config.mariadbClient, ["--protocol=socket", `--socket=${socket}`, "-u", "root", "-e", sql]);
          config.databaseInitialized = true;
          await writeFile(configPath(project.id), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
        }
        const phpSocket = join(socketDirectory(config), "php-fpm.sock");
        await rm(phpSocket, { force: true });
        if (!state.phpFpm?.running) {
          state.phpFpm = await agent.start(
            {
              workloadId: project.id,
              executable: config.phpFpm,
              args: ["-F", "-y", join(runtimeDirectory(project.id), "php-fpm.conf")],
              cwd: siteDirectory(project.id),
              env: nativeProcessEnvironment(),
            },
            { onOutput: capture(project.id, "php-fpm") },
          );
        }
        await waitForPath(
          phpSocket,
          startupTimeoutMs,
          () => state.phpFpm?.running !== false,
        );
        if (!state.nginx?.running) {
          state.nginx = await agent.start(
            {
              workloadId: project.id,
              executable: config.nginx,
              args: [
                "-c",
                join(runtimeDirectory(project.id), "nginx.conf"),
                "-p",
                runtimeDirectory(project.id),
                "-g",
                "daemon off;",
              ],
              cwd: runtimeDirectory(project.id),
              env: nativeProcessEnvironment(),
            },
            { onOutput: capture(project.id, "nginx") },
          );
        }
        await waitForPort(
          config.httpPort,
          startupTimeoutMs,
          () => state.nginx?.running !== false,
        );
        return { status: "running", url: `http://127.0.0.1:${config.httpPort}`, startedAt: new Date().toISOString() };
      } catch (error) {
        await driver.stop(project.id);
        throw error;
      }
    },
    async stop(projectId) {
      const state = processes.get(projectId);
      // In dependency order: nginx stops serving before php-fpm goes away, and
      // php-fpm releases its connections before the database does.
      for (const process of [state?.nginx, state?.phpFpm, state?.database]) {
        await process?.stop().catch(() => undefined);
      }
      processes.delete(projectId);
      return { status: "stopped", stoppedAt: new Date().toISOString() };
    },
    async status(projectId) {
      const state = processes.get(projectId);
      const config = await readConfig(projectId).catch(() => undefined);
      return state?.nginx?.running && config
        ? { status: "running", url: `http://127.0.0.1:${config.httpPort}` }
        : { status: "stopped" };
    },
    async logs(projectId) { return [...(processes.get(projectId)?.logs ?? [])]; },
    async destroy(projectId) {
      const config = await readConfig(projectId).catch(() => undefined);
      await driver.stop(projectId);
      if (config) {
        await rm(socketDirectory(config), { recursive: true, force: true });
      }
      await rm(projectDirectory(projectId), { recursive: true, force: true });
    },
    async close() {
      await Promise.all([...processes.keys()].map((projectId) => driver.stop(projectId)));
    },
  };
  return driver;
}
