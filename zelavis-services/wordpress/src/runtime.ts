import { IntegrationFailure, unwrapFailure } from "zelavis/adapters/project-runtime";
import type { TaggedFailure } from "zelavis/adapters/project-runtime";
import { Effect } from "effect";
import { defineEffectProjectRuntime, evaluate, integration, type EffectOperations } from "zelavis/adapters/project-runtime";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, Socket } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createLocalAgentProcessRunner, ZelavisProjectRuntimeError, type ZelavisAgentProcess, type ZelavisAgentProcessRunner, type ZelavisProjectLogEntry, type ZelavisProjectRecipeLock, type ZelavisProjectRecord, type ZelavisProjectRuntimeDriver, type ZelavisRecipeRuntimeContext, } from "zelavis/adapters/project-runtime";
/*
 * Keep host executables shared while every Project owns its service processes,
 * configuration, sockets, ports, logs, credentials, site files, and data.
 */
import { WORDPRESS_ARCHIVE_SHA256, WORDPRESS_RELEASE } from "./release.js";

const effectSleep = (milliseconds: number) => Effect.sleep(milliseconds);
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
export const WORDPRESS_APP_NAME = "@zelavis/wordpress";
const DEFAULT_STARTUP_TIMEOUT_MS = 120000;
const LOG_LIMIT = 500;
const MAX_WORDPRESS_ARCHIVE_BYTES = 64 * 1024 * 1024;
const downloadArchive = Effect.fn("WordPress.downloadArchive")(function* (release: string) {
    return yield* Effect.acquireUseRelease(
        Effect.sync(() => new AbortController()),
        controller => Effect.gen(function* () {
            const response = yield* integration(signal => fetch(`https://wordpress.org/wordpress-${release}.tar.gz`, {
                signal: AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120000)]),
            }), { interruptible: true });
            if (!response.ok || !response.body)
                return yield* new IntegrationFailure(new Error(`WordPress download failed with HTTP ${response.status}.`));
            if (Number(response.headers.get("content-length") ?? 0) > MAX_WORDPRESS_ARCHIVE_BYTES)
                return yield* new IntegrationFailure(new Error("WordPress release archive exceeds the provisioning size limit."));
            const body = new Uint8Array(yield* integration(() => response.arrayBuffer(), { interruptible: true }));
            if (body.byteLength > MAX_WORDPRESS_ARCHIVE_BYTES)
                return yield* new IntegrationFailure(new Error("WordPress release archive exceeds the provisioning size limit."));
            return body;
        }),
        controller => Effect.sync(() => controller.abort()),
    );
});
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
        if (value !== undefined)
            environment[name] = value;
    }
    return environment;
}
const resolveRuntimeAccount = Effect.fn("WordPress.resolveRuntimeAccount")(function* (configured: string | undefined): Effect.fn.Return<{
    name: string;
    group: string;
    uid: number;
    gid: number;
} | undefined, TaggedFailure> {
    if (process.getuid?.() !== 0)
        return undefined;
    // A configured account is used or refused; it is not quietly replaced with a
    // fallback, because an operator who named one is describing their host.
    const candidates = configured ? [configured] : ["www-data", "mysql", "nobody"];
    for (const name of candidates) {
        const uid = yield* run("id", ["-u", name], { allowFailure: true });
        const gid = yield* run("id", ["-g", name], { allowFailure: true });
        // The group's name, not the user's. They coincide on Debian and do not on
        // macOS, and PHP-FPM wants the name.
        const group = yield* run("id", ["-gn", name], { allowFailure: true });
        if (uid.code === 0 && gid.code === 0 && group.code === 0) {
            return {
                name,
                group: group.stdout.trim(),
                uid: Number(uid.stdout.trim()),
                gid: Number(gid.stdout.trim()),
            };
        }
    }
    return yield* Effect.fail(new ZelavisProjectRuntimeError(configured
        ? `Native WordPress is configured to run as "${configured}", but no such account exists on this host.`
        : "Native WordPress is running as root and found no unprivileged account to run its daemons as. " +
            "MariaDB will not start as root. Create one of www-data, mysql or nobody, name one with the " +
            "WordPress runtime's `user` option, or run Zelavis as an ordinary user with package authority."));
});
function isMissingFileError(error: unknown): boolean {
    error = unwrapFailure(error);
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
const run = Effect.fn("WordPress.run")(function* (executable: string, args: readonly string[], options: {
    cwd?: string;
    allowFailure?: boolean;
    /**
     * Run with the Platform's own environment.
     *
     * Only for host package managers. `brew` are configured through
     * environment variables an operator sets — a prefix, a mirror, a proxy, a
     * non-interactive flag — and stripping those turns "install the packages
     * this host needs" into a failure the operator cannot explain. They also
     * run as the operator provisioning their own machine, not as Project code,
     * which is the distinction that makes this safe where it would not be for
     * anything a Project can influence.
     */
    inheritEnvironment?: boolean;
} = {}): Effect.fn.Return<{
    code: number;
    stdout: string;
    stderr: string;
}, TaggedFailure> {
    return yield* Effect.callback<{ code: number; stdout: string; stderr: string }, TaggedFailure>(resume => {
        const rejectRun = (error: Error) => resume(Effect.fail(new IntegrationFailure(error)));
        const resolveRun = (value: { code: number; stdout: string; stderr: string }) => resume(Effect.succeed(value));
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
        child.once("error", (error) => rejectRun(new Error(`Required native executable "${executable}" is unavailable.`, { cause: error })));
        child.once("exit", (code) => {
            const exitCode = code ?? 1;
            if (exitCode !== 0 && !options.allowFailure) {
                rejectRun(new Error(`${executable} failed: ${(stderr || stdout).trim() || `exit ${exitCode}`}`));
                return;
            }
            resolveRun({ code: exitCode, stdout, stderr });
        });
        return Effect.callback<void>(done => {
            if (!child.pid || child.exitCode !== null || child.signalCode !== null) { done(Effect.void); return; }
            child.once("exit", () => done(Effect.void));
            child.kill("SIGKILL");
        });
    });
});
const resolveExecutable = Effect.fn("WordPress.resolveExecutable")(function* (candidates: readonly string[], versionArgs: readonly string[] = ["--version"], displayName = candidates.join(" or "), acceptProbeFailure = false): Effect.fn.Return<string, TaggedFailure> {
    for (const candidate of candidates) {
        const probe = yield* Effect.catch(run(candidate, versionArgs, { allowFailure: true }), Effect.fn("WordPress.recover")(function* () { return undefined; }));
        if (probe && (acceptProbeFailure || probe.code === 0))
            return candidate;
    }
    return yield* Effect.fail(new ZelavisProjectRuntimeError(`Native WordPress requires ${displayName}, but Zelavis could not find it on this host.`));
});
const executableAvailable = Effect.fn("WordPress.executableAvailable")(function* (executable: string): Effect.fn.Return<boolean, TaggedFailure> {
    return yield* Effect.catch(Effect.gen(function* () {
        // `brew` is one of the executables probed here and reports its version
        // from its own installation, which it locates through its environment.
        return ((yield* run(executable, ["--version"], {
            allowFailure: true,
            inheritEnvironment: true,
        }))).code === 0;
    }), Effect.fn("WordPress.recover")(function* (_error) {
        return false;
    }));
});
const provisionNativeWordPressPackages = Effect.fn("WordPress.provisionNativeWordPressPackages")(function* (): Effect.fn.Return<void, TaggedFailure> {
    if (process.platform === "linux") {
        return yield* Effect.fail(new ZelavisProjectRuntimeError("Native WordPress dependencies are missing. Approve host package installation in the create-project form, or run: zelavis host-operations submit zelavis.packages-install --arg set=wordpress-stack"));
    }
    if (process.platform === "darwin" && (yield* executableAvailable("brew"))) {
        yield* Effect.catch(Effect.gen(function* () {
            (yield* run("brew", ["install", ...BREW_WORDPRESS_PACKAGES], {
                inheritEnvironment: true,
            }));
        }), Effect.fn("WordPress.recover")(function* (cause) {
            return (yield* Effect.fail(new ZelavisProjectRuntimeError("Zelavis could not install the native WordPress dependencies through Homebrew. Check the Homebrew installation and retry the Project start.", { cause })));
        }));
        return;
    }
    return yield* Effect.fail(new ZelavisProjectRuntimeError("Native WordPress requires a supported host package provider (APT on Debian/Ubuntu or Homebrew on macOS)."));
});
const brewFormulaExecutable = Effect.fn("WordPress.brewFormulaExecutable")(function* (formula: string, relativePath: string): Effect.fn.Return<string | undefined, TaggedFailure> {
    if (process.platform !== "darwin" || !(yield* executableAvailable("brew"))) {
        return undefined;
    }
    // Homebrew resolves its own prefix from its environment, so asking it where
    // a formula lives is one of the calls that needs that environment.
    const prefix = yield* run("brew", ["--prefix", formula], {
        allowFailure: true,
        inheritEnvironment: true,
    });
    const directory = prefix.stdout.trim();
    return prefix.code === 0 && directory ? join(directory, relativePath) : undefined;
});
const resolveNativeWordPressExecutables = Effect.fn("WordPress.resolveNativeWordPressExecutables")(function* (): Effect.fn.Return<NativeWordPressExecutables, TaggedFailure> {
    const resolveAll = Effect.fn("WordPress.step")(function* (): Effect.fn.Return<NativeWordPressExecutables, TaggedFailure> {
        const [brewNginx, brewPhp, brewPhpFpm, brewMariadbd, brewInstallDb, brewClient] = yield* Effect.all([
            brewFormulaExecutable("nginx", "bin/nginx"),
            brewFormulaExecutable("php", "bin/php"),
            brewFormulaExecutable("php", "sbin/php-fpm"),
            brewFormulaExecutable("mariadb", "bin/mariadbd"),
            brewFormulaExecutable("mariadb", "bin/mariadb-install-db"),
            brewFormulaExecutable("mariadb", "bin/mariadb"),
        ], { concurrency: 6 });
        return {
            nginx: (yield* resolveExecutable(["nginx", ...(brewNginx ? [brewNginx] : [])], ["-v"], "Nginx")),
            php: (yield* resolveExecutable(["php", ...(brewPhp ? [brewPhp] : [])], ["--version"], "PHP CLI")),
            phpFpm: (yield* resolveExecutable([
                "php-fpm",
                "php-fpm8.5",
                "php-fpm8.4",
                "php-fpm8.3",
                "php-fpm8.2",
                ...(brewPhpFpm ? [brewPhpFpm] : []),
            ], ["-v"], "PHP-FPM")),
            mariadbd: (yield* resolveExecutable(["mariadbd", ...(brewMariadbd ? [brewMariadbd] : [])], ["--version"], "MariaDB Server")),
            mariadbInstallDb: (yield* resolveExecutable(["mariadb-install-db", ...(brewInstallDb ? [brewInstallDb] : [])], ["--help"], "MariaDB database initialization tools", true)),
            mariadbClient: (yield* resolveExecutable(["mariadb", ...(brewClient ? [brewClient] : [])], ["--version"], "MariaDB Client")),
        };
    });
    return yield* Effect.catch(Effect.gen(function* () {
        return (yield* resolveAll());
    }), Effect.fn("WordPress.recover")(function* (_error) {
        (yield* provisionNativeWordPressPackages());
        return (yield* resolveAll());
    }));
});
const availablePort = () => Effect.callback<number, TaggedFailure>(resume => {
    const server = createServer();
    server.once("error", error => resume(Effect.fail(new IntegrationFailure(error))));
    server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
            resume(Effect.fail(new IntegrationFailure(new Error("Could not allocate a native WordPress port."))));
            return;
        }
        server.close(error => resume(error ? Effect.fail(new IntegrationFailure(error)) : Effect.succeed(address.port)));
    });
    return Effect.sync(() => { if (server.listening) server.close(); });
});

const portAccepts = (port: number) => Effect.callback<boolean>(resume => {
    const socket = new Socket();
    const settle = (accepted: boolean) => { socket.destroy(); resume(Effect.succeed(accepted)); };
    socket.setTimeout(1000);
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
    socket.once("timeout", () => settle(false));
    socket.connect(port, "127.0.0.1");
    return Effect.sync(() => socket.destroy());
});

const waitForPort = Effect.fn("WordPress.waitForPort")(function* (port: number, timeoutMs: number, isRunning?: () => boolean): Effect.fn.Return<void, TaggedFailure> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isRunning && !isRunning()) {
            return yield* new IntegrationFailure(new Error(`Native service for port ${port} exited before it began listening.`));
        }
        const connected = yield* portAccepts(port);
        if (connected)
            return;
        yield* effectSleep(500);
    }
    return yield* new IntegrationFailure(new Error(`Native service on port ${port} did not become ready.`));
});
const waitForPath = Effect.fn("WordPress.waitForPath")(function* (path: string, timeoutMs: number, isRunning?: () => boolean): Effect.fn.Return<void, TaggedFailure> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (isRunning && !isRunning()) {
            return yield* new IntegrationFailure(new Error(`Native service exited before creating ${path}.`));
        }
        if ((yield* Effect.orElseSucceed(Effect.map(integration(() => access(path)), () => true), () => false)))
            return;
        yield* effectSleep(250);
    }
    return yield* new IntegrationFailure(new Error(`Native service did not create ${path}.`));
});
function phpString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function sqlIdentifier(value: string): string {
    if (!/^[a-z0-9_]+$/i.test(value))
        throw new Error("Unsafe generated database identifier.");
    return `\`${value}\``;
}
function sqlString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
function versionAtLeast(actual: string, minimum: readonly [
    number,
    number
]): boolean {
    const match = actual.match(/(\d+)\.(\d+)/);
    if (!match)
        return false;
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
export function createNativeWordPressProjectRuntime(options: NativeWordPressProjectRuntimeOptions): ZelavisProjectRuntimeDriver {
    const projectsDirectory = resolve(options.directory);
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const processes = new Map<string, NativeWordPressProcesses>();
    const agent = options.agent ??
        createLocalAgentProcessRunner({
            stateDirectory: join(projectsDirectory, ".agent-processes"),
        });
    let runtimeAccount: Effect.Success<ReturnType<typeof resolveRuntimeAccount>> | undefined;
    let runtimeAccountResolved = false;
    const account = Effect.fn("WordPress.account")(function* () {
        if (!runtimeAccountResolved) {
            runtimeAccount = (yield* resolveRuntimeAccount(options.user));
            runtimeAccountResolved = true;
        }
        return runtimeAccount;
    });
    const currentGroupName = Effect.fn("WordPress.currentGroupName")(function* (): Effect.fn.Return<string, TaggedFailure> {
        const group = yield* run("id", ["-gn"], { allowFailure: true });
        const name = group.stdout.trim();
        return group.code === 0 && name ? name : userInfo().username;
    });
    const handOver = Effect.fn("WordPress.handOver")(function* (path: string) {
        const owner = yield* account();
        if (!owner)
            return;
        // Not `allowFailure`. A silent chown failure surfaces later as MariaDB
        // being unable to write its own data directory, which reads as a database
        // problem and is a permissions one.
        yield* run("chown", ["-R", `${owner.uid}:${owner.gid}`, path]);
        yield* ensureTraversable(dirname(path), owner);
    });
    const ensureTraversable = Effect.fn("WordPress.ensureTraversable")(function* (from: string, owner: {
        uid: number;
        gid: number;
    }): Effect.fn.Return<void, TaggedFailure> {
        let current = resolve(from);
        while (true) {
            const info = yield* Effect.catch(integration(() => stat(current)), Effect.fn("WordPress.recover")(function* () { return undefined; }));
            if (!info)
                return;
            const alreadyOwned = info.uid === owner.uid;
            const traversable = alreadyOwned || (info.mode & 0o001) !== 0;
            if (!traversable) {
                if (info.uid !== process.getuid?.())
                    return;
                yield* Effect.catch(integration(() => chmod(current, info.mode | 0o001)), Effect.fn("WordPress.recover")(function* () { return undefined; }));
            }
            const parent = dirname(current);
            if (parent === current)
                return;
            current = parent;
        }
    });
    const projectDirectory = (id: string) => join(projectsDirectory, id);
    const runtimeDirectory = (id: string) => join(projectDirectory(id), ".zelavis");
    const configPath = (id: string) => join(runtimeDirectory(id), "wordpress-native.json");
    const siteDirectory = (id: string) => join(runtimeDirectory(id), "wordpress");
    const databaseDirectory = (id: string) => join(runtimeDirectory(id), "mariadb");
    const socketDirectory = (config: NativeWordPressConfig) => join("/tmp", `zv-wp-${config.socketId}`);
    const readConfig = Effect.fn("WordPress.readConfig")(function* (projectId: string): Effect.fn.Return<NativeWordPressConfig, TaggedFailure> {
        return (yield* Effect.flatMap(integration(() => readFile(configPath(projectId), "utf8")), value => evaluate(() => JSON.parse(value)))) as NativeWordPressConfig;
    });
    function appendLog(projectId: string, stream: ZelavisProjectLogEntry["stream"], message: string) {
        const state = processes.get(projectId) ?? { logs: [] };
        for (const line of message.split("\n").filter(Boolean)) {
            state.logs.push({ timestamp: new Date().toISOString(), stream, message: line });
        }
        if (state.logs.length > LOG_LIMIT)
            state.logs.splice(0, state.logs.length - LOG_LIMIT);
        processes.set(projectId, state);
    }
    /** Labels a process's output, so three of them share one Project log. */
    function capture(projectId: string, label: string) {
        return ({ stream, line }: {
            stream: "stdout" | "stderr";
            line: string;
        }) => appendLog(projectId, stream, `[${label}] ${line}`);
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
        description: "Runs a version-pinned WordPress release with dedicated native Nginx, PHP-FPM, and MariaDB processes, configuration, sockets, logs, and data directories.",
    });
    const driver: EffectOperations<ZelavisProjectRuntimeDriver> = {
        name: "native-wordpress",
        runtimeKinds: Object.freeze(["native"]),
        defaultRuntimeKind: "native",
        startupConcurrency: 1,
        capabilities: () => capabilities,
        prepare: Effect.fn("WordPress.prepare")(function* (project: ZelavisProjectRecord, recipe: ZelavisProjectRecipeLock) {
            if (recipe.name !== WORDPRESS_APP_NAME)
                return yield* new IntegrationFailure(new Error(`Unsupported native WordPress recipe "${recipe.name}".`));
            yield* integration(() => mkdir(siteDirectory(project.id), { recursive: true, mode: 0o700 }));
            yield* integration(() => mkdir(databaseDirectory(project.id), { recursive: true, mode: 0o700 }));
            for (const name of [
                "tmp",
                "sessions",
                "nginx-client-temp",
                "nginx-proxy-temp",
                "nginx-fastcgi-temp",
                "nginx-uwsgi-temp",
                "nginx-scgi-temp",
            ]) {
                yield* integration(() => mkdir(join(runtimeDirectory(project.id), name), {
                    recursive: true,
                    mode: 0o700,
                }));
            }
            let storedConfig: NativeWordPressConfig | undefined;
            yield* Effect.catch(Effect.gen(function* () {
                storedConfig = (yield* readConfig(project.id));
            }), Effect.fn("WordPress.recover")(function* (error) {
                if (!isMissingFileError(error))
                    return (yield* Effect.fail(error));
            }));
            const owner = yield* account();
            const groupName = owner?.group ?? (yield* currentGroupName());
            const executables = yield* resolveNativeWordPressExecutables();
            const phpVersion = ((yield* run(executables.php, ["-r", "echo PHP_VERSION;"]))).stdout.trim();
            const phpFpmVersionResult = yield* run(executables.phpFpm, ["-v"]);
            const phpFpmVersion = `${phpFpmVersionResult.stdout} ${phpFpmVersionResult.stderr}`;
            if (!versionAtLeast(phpVersion, [8, 2]) ||
                !versionAtLeast(phpFpmVersion, [8, 2])) {
                return yield* new IntegrationFailure(new Error(`Native WordPress requires PHP CLI and PHP-FPM 8.2 or newer; found CLI ${phpVersion} and FPM ${phpFpmVersion.trim()}.`));
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
            const extensionCheck = yield* run(executables.php, [
                "-r",
                `$required=${JSON.stringify(requiredExtensions)}; echo json_encode(array_values(array_filter($required, fn($extension) => !extension_loaded($extension))));`,
            ]);
            const missingExtensions = (yield* evaluate(() => JSON.parse(extensionCheck.stdout))) as string[];
            if (missingExtensions.length > 0) {
                return yield* new IntegrationFailure(new Error(`Native WordPress is missing required PHP extensions: ${missingExtensions.join(", ")}.`));
            }
            const mariadbVersionResult = yield* run(executables.mariadbd, [
                "--version",
            ]);
            const mariadbVersion = `${mariadbVersionResult.stdout} ${mariadbVersionResult.stderr}`;
            if (!versionAtLeast(mariadbVersion, [10, 6])) {
                return yield* new IntegrationFailure(new Error(`Native WordPress requires MariaDB 10.6 or newer; found ${mariadbVersion.trim()}.`));
            }
            const httpPort = storedConfig?.httpPort ?? ((yield* availablePort()));
            let databasePort = storedConfig?.databasePort ?? ((yield* availablePort()));
            while (databasePort === httpPort)
                databasePort = (yield* availablePort());
            const config: NativeWordPressConfig = {
                ...executables,
                httpPort,
                databasePort,
                databaseName: "wordpress",
                databaseUser: "wordpress",
                databasePassword: storedConfig?.databasePassword ??
                    randomBytes(32).toString("base64url"),
                socketId: storedConfig?.socketId ?? randomBytes(12).toString("hex"),
                databaseInitialized: storedConfig?.databaseInitialized === true,
            };
            yield* integration(() => writeFile(configPath(project.id), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }));
            yield* integration(() => mkdir(socketDirectory(config), { recursive: true, mode: 0o700 }));
            yield* handOver(socketDirectory(config));
            const phpFpmConfiguration = join(runtimeDirectory(project.id), "php-fpm.conf");
            yield* integration(() => writeFile(phpFpmConfiguration, phpFpmConfig({
                runtimeDirectory: runtimeDirectory(project.id),
                socketDirectory: socketDirectory(config),
                siteDirectory: siteDirectory(project.id),
                username: owner?.name ?? userInfo().username,
                group: owner?.group ?? (groupName),
            }), { mode: 0o600 }));
            const nginxConfiguration = join(runtimeDirectory(project.id), "nginx.conf");
            yield* integration(() => writeFile(nginxConfiguration, nginxConfig({
                httpPort: config.httpPort,
                runtimeDirectory: runtimeDirectory(project.id),
                socketDirectory: socketDirectory(config),
                siteDirectory: siteDirectory(project.id),
                ...(owner ? { runAs: owner!.name } : {}),
            }), { mode: 0o600 }));
            yield* run(config.phpFpm, ["-tt", "-y", phpFpmConfiguration]);
            yield* run(config.nginx, [
                "-t",
                "-c",
                nginxConfiguration,
                "-p",
                runtimeDirectory(project.id),
            ]);
            yield* Effect.catch(Effect.gen(function* () {
                (yield* integration(() => readFile(join(siteDirectory(project.id), "wp-includes", "version.php"))));
            }), Effect.fn("WordPress.recover")(function* (error) {
                if (!isMissingFileError(error))
                    return (yield* Effect.fail(error));
                const release = WORDPRESS_RELEASE;
                const archive = join(runtimeDirectory(project.id), `wordpress-${release}.tar.gz`);
                const archiveBody = yield* downloadArchive(release);
                // Nothing is written or unpacked until the bytes are the ones this
                // package was released with.
                const digest = Buffer.from((yield* integration(() => crypto.subtle.digest("SHA-256", archiveBody)))).toString("hex");
                if (digest !== WORDPRESS_ARCHIVE_SHA256) {
                    return (yield* new IntegrationFailure(new Error(`The WordPress ${release} archive does not match the digest this recipe pins.`)));
                }
                (yield* integration(() => writeFile(archive, archiveBody, { mode: 0o600 })));
                const archiveEntries = ((yield* run("tar", ["-tzf", archive]))).stdout
                    .split("\n")
                    .filter(Boolean);
                if (archiveEntries.some((entry) => {
                    const parts = entry.split("/");
                    return parts[0] !== "wordpress" || parts.includes("..") || entry.startsWith("/");
                })) {
                    return (yield* new IntegrationFailure(new Error("WordPress release archive contains an unsafe path.")));
                }
                (yield* run("tar", ["-xzf", archive, "--strip-components=1", "-C", siteDirectory(project.id)]));
                (yield* integration(() => rm(archive, { force: true })));
            }));
            yield* Effect.catch(Effect.gen(function* () {
                (yield* integration(() => readFile(join(siteDirectory(project.id), "wp-config.php"))));
            }), Effect.fn("WordPress.recover")(function* (error) {
                if (!isMissingFileError(error))
                    return (yield* Effect.fail(error));
                (yield* integration(() => writeFile(join(siteDirectory(project.id), "wp-config.php"), wordpressConfig(config), { mode: 0o600 })));
            }));
            yield* integration(() => writeFile(join(projectDirectory(project.id), "project.json"), `${JSON.stringify({ ...project, recipe, runtime: { driver: driver.name, capabilities } }, null, 2)}\n`, { mode: 0o600 }));
            // Last, once every file exists. Handing the tree over earlier would leave
            // whatever `prepare` wrote afterwards — the generated wp-config.php among
            // it — owned by the Platform and unreadable to the daemons.
            yield* handOver(projectDirectory(project.id));
        }),
        start: Effect.fn("WordPress.start")(function* (project: Parameters<NonNullable<ZelavisProjectRuntimeDriver["start"]>>[0], placement: Parameters<NonNullable<ZelavisProjectRuntimeDriver["start"]>>[1]) {
            const owner = yield* account();
            const config = yield* readConfig(project.id);
            const state = processes.get(project.id) ?? { logs: [] };
            processes.set(project.id, state);
            return yield* Effect.uninterruptibleMask(restore => Effect.gen(function* () {
                if (!config.databaseInitialized) {
                    const installAs = owner;
                    yield* run(config.mariadbInstallDb, [
                        `--datadir=${databaseDirectory(project.id)}`,
                        "--auth-root-authentication-method=normal",
                        "--skip-test-db",
                        ...(installAs ? [`--user=${installAs.name}`] : []),
                    ]);
                }
                if (!state.database?.running) {
                    state.database = (yield* integration(() => agent.start({
                        workloadId: project.id,
                        ...(placement ? { placement } : {}),
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
                            ...(owner ? [`--user=${owner!.name}`] : []),
                        ],
                        cwd: runtimeDirectory(project.id),
                        env: nativeProcessEnvironment(),
                    }, { onOutput: capture(project.id, "mariadb") })));
                }
                yield* restore(waitForPort(config.databasePort, startupTimeoutMs, () => state.database?.running !== false));
                if (!config.databaseInitialized) {
                    const socket = join(socketDirectory(config), "mariadb.sock");
                    const sql = [
                        `CREATE DATABASE IF NOT EXISTS ${sqlIdentifier(config.databaseName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
                        `CREATE USER IF NOT EXISTS ${sqlString(config.databaseUser)}@'127.0.0.1' IDENTIFIED BY ${sqlString(config.databasePassword)}`,
                        `GRANT ALL PRIVILEGES ON ${sqlIdentifier(config.databaseName)}.* TO ${sqlString(config.databaseUser)}@'127.0.0.1'`,
                        "FLUSH PRIVILEGES",
                    ].join("; ");
                    yield* run(config.mariadbClient, ["--protocol=socket", `--socket=${socket}`, "-u", "root", "-e", sql]);
                    config.databaseInitialized = true;
                    yield* integration(() => writeFile(configPath(project.id), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }));
                }
                const phpSocket = join(socketDirectory(config), "php-fpm.sock");
                if (!state.phpFpm?.running) {
                    // Only a stale socket from a dead PHP-FPM is cleared. Removing the
                    // live one of a PHP-FPM that keeps running leaves it listening on a
                    // path nothing can reach, and nginx answers every request with 502.
                    yield* integration(() => rm(phpSocket, { force: true }));
                    state.phpFpm = (yield* integration(() => agent.start({
                        workloadId: project.id,
                        ...(placement ? { placement } : {}),
                        executable: config.phpFpm,
                        args: ["-F", "-y", join(runtimeDirectory(project.id), "php-fpm.conf")],
                        cwd: siteDirectory(project.id),
                        env: nativeProcessEnvironment(),
                    }, { onOutput: capture(project.id, "php-fpm") })));
                }
                yield* restore(waitForPath(phpSocket, startupTimeoutMs, () => state.phpFpm?.running !== false));
                if (!state.nginx?.running) {
                    state.nginx = (yield* integration(() => agent.start({
                        workloadId: project.id,
                        ...(placement ? { placement } : {}),
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
                    }, { onOutput: capture(project.id, "nginx") })));
                }
                yield* restore(waitForPort(config.httpPort, startupTimeoutMs, () => state.nginx?.running !== false));
                return { status: "running" as const, url: `http://127.0.0.1:${config.httpPort}`, startedAt: new Date().toISOString() };
            })).pipe(Effect.onError(() => driver.stop(project.id).pipe(Effect.orDie)));
        }),
        stop: Effect.fn("WordPress.stop")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["stop"]>>[0]) {
            const state = processes.get(projectId);
            // In dependency order: nginx stops serving before php-fpm goes away, and
            // php-fpm releases its connections before the database does.
            for (const process of [state?.nginx, state?.phpFpm, state?.database]) {
                if (process) yield* integration(() => process.stop()).pipe(Effect.uninterruptible);
            }
            processes.delete(projectId);
            return { status: "stopped", stoppedAt: new Date().toISOString() };
        }),
        status: Effect.fn("WordPress.status")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["status"]>>[0]) {
            const state = processes.get(projectId);
            const config = yield* Effect.catch(readConfig(projectId), Effect.fn("WordPress.recover")(function* () { return undefined; }));
            return state?.nginx?.running && config
                ? { status: "running", url: `http://127.0.0.1:${config.httpPort}` }
                : { status: "stopped" };
        }),
        logs: Effect.fn("WordPress.logs")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["logs"]>>[0]) { return [...(processes.get(projectId)?.logs ?? [])]; }),
        destroy: Effect.fn("WordPress.destroy")(function* (projectId: Parameters<NonNullable<ZelavisProjectRuntimeDriver["destroy"]>>[0]) {
            const config = yield* Effect.catch(readConfig(projectId), Effect.fn("WordPress.recover")(function* () { return undefined; }));
            yield* driver.stop(projectId);
            if (config) {
                yield* integration(() => rm(socketDirectory(config), { recursive: true, force: true }));
            }
            yield* integration(() => rm(projectDirectory(projectId), { recursive: true, force: true }));
        }),
        close: Effect.fn("WordPress.close")(function* () {
            yield* Effect.forEach([...processes.keys()], projectId => driver.stop(projectId), { concurrency: 8, discard: true });
        }),
    };
    return defineEffectProjectRuntime(driver);
}
/** The runtime the Platform loads from the frozen copy of this package. */
export function createProjectRuntime(context: ZelavisRecipeRuntimeContext): ZelavisProjectRuntimeDriver {
    const options = context.options as {
        startupTimeoutMs?: number;
        user?: string;
    };
    return createNativeWordPressProjectRuntime({
        directory: context.directory,
        agent: context.agent,
        ...(typeof options.startupTimeoutMs === "number" ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
        ...(typeof options.user === "string" ? { user: options.user } : {}),
    });
}
