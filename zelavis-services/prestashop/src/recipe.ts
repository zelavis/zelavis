import { Effect } from "effect";
import { RecipeError, RecipeHost, defineRecipe, type ProcessPlan, type RecipeContext, type RecipeHostApi } from "zelavis/recipe";

/**
 * PrestaShop as a recipe: Caddy, PHP-FPM and a dedicated MariaDB, with the PHP release this PrestaShop is
 * built for (8.1, not whatever the host has), from PrestaShop's own release archive. That archive is a zip
 * holding another zip; both are unpacked by the recipe host without any tool on the host. PrestaShop's own
 * installer, in the browser or on the command line, asks for the database's address, name, user and
 * password, which the Platform shows as the Project's setup values.
 *
 * Layout below the Project's directory (`context.directories.root`): `site/` is PrestaShop, `db/` the
 * database, `run/` pid files and logs, the rest temporary space.
 */

const MINIMUM_PHP: readonly [number, number] = [8, 1];
const MINIMUM_MARIADB: readonly [number, number] = [10, 6];
const REQUIRED_EXTENSIONS = ["curl", "dom", "fileinfo", "gd", "iconv", "intl", "mbstring", "openssl", "pdo_mysql", "simplexml", "zip", "zlib"] as const;
const TEMPORARY_DIRECTORIES = ["tmp", "sessions", "run"] as const;
const DATABASE_NAME = "prestashop";
const DATABASE_USER = "prestashop";

/** Where the Project keeps a named directory now, absolute and below the root. A newer recipe may name another path; the Platform moves the data at the next start from a stop. */
const place = (context: RecipeContext, name: "site" | "db") => {
  const absolute = context.directories.named[name];
  if (absolute === undefined) throw refuse("install", `The Platform did not provide the "${name}" directory.`);
  return { absolute, relative: absolute.slice(context.directories.root.length + 1) };
};

const refuse = (operation: string, message: string) => new RecipeError({ operation, message });

function versionAtLeast(text: string, minimum: readonly [number, number]): boolean {
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

function phpFpmConfig(context: RecipeContext): string {
  const { root, sockets } = context.directories;
  const { user, group } = context.account;
  for (const value of [user, group]) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw refuse("install", "The host account cannot be represented in PHP-FPM configuration.");
  }
  return `[global]
pid = ${root}/run/php-fpm.pid
error_log = ${root}/run/php-fpm.log
daemonize = no

[prestashop]
user = ${user}
group = ${group}
listen = ${sockets}/php-fpm.sock
; The socket is created by the PHP-FPM master, which is still root when the Platform is. Without
; these it lands root-owned and the web server, which runs as the same unprivileged account,
; get a 502. Comments here are ";" not "#": PHP-FPM parses this with the INI parser.
listen.owner = ${user}
listen.group = ${group}
listen.mode = 0600
pm = dynamic
pm.max_children = 8
pm.start_servers = 2
pm.min_spare_servers = 1
pm.max_spare_servers = 3
pm.max_requests = 500
chdir = ${place(context, "site").absolute}
catch_workers_output = yes
clear_env = yes
security.limit_extensions = .php
php_admin_value[upload_tmp_dir] = ${root}/tmp
php_admin_value[session.save_path] = ${root}/sessions
php_admin_value[error_log] = ${root}/run/php-errors.log
php_admin_flag[log_errors] = on
php_admin_value[memory_limit] = 512M
php_admin_value[max_input_vars] = 10000
php_admin_value[upload_max_filesize] = 64M
php_admin_value[post_max_size] = 64M
`;
}

function caddyfile(context: RecipeContext): string {
  const { root, sockets } = context.directories;
  const web = context.ports.web;
  const site = place(context, "site").absolute;
  if (web === undefined) throw refuse("install", "The recipe needs a web port.");
  // Caddy cannot give up root itself (nginx could); the Platform runs unprivileged on a system installation.
  if (context.account.switchUser) throw refuse("install", "The web server (Caddy) cannot drop privileges: run the Platform as its own unprivileged account.");
  return `{
	admin off
	auto_https off
	persist_config off
}

http://:${web} {
	# Any Host is served (the Platform forwards the visitor's own); the listener itself is loopback only.
	bind 127.0.0.1
	root * ${quoted(site)}
	log {
		output file ${quoted(`${root}/run/caddy-access.log`)}
	}
	request_body {
		max_size 64MB
	}
	# PrestaShop's code, configuration, caches and Composer files are never served directly.
	@denied path /app/* /var/* /src/* /vendor/* /classes/* /config/* /controllers/* /docs/* /tools/* /localization/* /mails/* /override/* /pdf/* /translations/* /composer.* /Makefile /INSTALL.txt /LICENSES/*
	respond @denied 403
	@hidden {
		path_regexp hidden ^/\\.
		not path /.well-known/*
	}
	respond @hidden 403
	php_fastcgi unix/${sockets}/php-fpm.sock
	file_server
}
`;
}

const requireVersions = (host: RecipeHostApi) => Effect.gen(function* () {
  const php = yield* host.run({ command: "php", args: ["-r", "echo PHP_VERSION;"], timeoutMs: 30_000 });
  const fpm = yield* host.run({ command: "php-fpm", args: ["-v"], timeoutMs: 30_000 });
  if (php.code !== 0 || !versionAtLeast(php.stdout, MINIMUM_PHP) || !versionAtLeast(`${fpm.stdout} ${fpm.stderr}`, MINIMUM_PHP)) {
    return yield* Effect.fail(refuse("install", `PrestaShop needs PHP CLI and PHP-FPM ${MINIMUM_PHP.join(".")} or newer; found CLI ${php.stdout.trim()} and FPM ${fpm.stdout.trim().split("\n")[0] ?? ""}.`));
  }
  const extensions = yield* host.run({
    command: "php", timeoutMs: 30_000,
    args: ["-r", `$required=${JSON.stringify(REQUIRED_EXTENSIONS)}; echo json_encode(array_values(array_filter($required, fn($extension) => !extension_loaded($extension))));`],
  });
  const missing = yield* Effect.try({ try: () => JSON.parse(extensions.stdout) as unknown, catch: () => refuse("install", "PHP did not report its extensions.") });
  if (!Array.isArray(missing) || missing.length > 0) {
    return yield* Effect.fail(refuse("install", `PrestaShop is missing required PHP extensions: ${Array.isArray(missing) ? missing.join(", ") : "unknown"}.`));
  }
  const database = yield* host.run({ command: "mariadbd", args: ["--version"], timeoutMs: 30_000 });
  if (!versionAtLeast(`${database.stdout} ${database.stderr}`, MINIMUM_MARIADB)) {
    return yield* Effect.fail(refuse("install", `PrestaShop needs MariaDB ${MINIMUM_MARIADB.join(".")} or newer; found ${database.stdout.trim()}.`));
  }
});

const installSite = (host: RecipeHostApi, context: RecipeContext) => Effect.gen(function* () {
  const site = place(context, "site").relative;
  if (!(yield* host.files.exists(`${site}/init.php`))) {
    yield* host.progress({ phase: "install", message: `Downloading PrestaShop ${context.software.version}.` });
    yield* host.download({ url: context.software.archive, sha256: context.software.sha256, maxBytes: context.software.maxBytes, destination: "dl/prestashop.zip" });
    // A half-extracted earlier attempt is replaced, not merged into.
    yield* host.files.remove(site);
    yield* host.files.remove("dl/outer");
    // The release is a zip that holds the shop as a second zip.
    yield* host.extract("dl/prestashop.zip", "dl/outer");
    yield* host.extract("dl/outer/prestashop.zip", site);
    yield* host.files.remove("dl");
  }
});

const initializeDatabase = (host: RecipeHostApi, context: RecipeContext) => Effect.gen(function* () {
  const database = place(context, "db");
  const marker = `${database.relative}/.zelavis-initialized`;
  if (yield* host.files.exists(marker)) return;
  yield* host.progress({ phase: "install", message: "Initializing the database." });
  const password = yield* host.secret("db-password");
  const { root } = context.directories;
  // An earlier attempt that died partway left a data directory with nothing in it worth keeping.
  yield* host.files.remove(database.relative);
  yield* host.files.mkdir(database.relative);
  // The first FLUSH PRIVILEGES turns account management on: bootstrap runs without grant tables.
  yield* host.files.write("run/init.sql", [
    `FLUSH PRIVILEGES;\nCREATE DATABASE IF NOT EXISTS \`${DATABASE_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`,
    `CREATE USER IF NOT EXISTS ${sqlString(DATABASE_USER)}@'127.0.0.1' IDENTIFIED BY '`, password, `';\n`,
    `GRANT ALL PRIVILEGES ON \`${DATABASE_NAME}\`.* TO ${sqlString(DATABASE_USER)}@'127.0.0.1';\nFLUSH PRIVILEGES;\n`,
  ]);
  const created = yield* host.run({
    command: "mariadb-install-db", timeoutMs: 10 * 60_000,
    args: [`--datadir=${database.absolute}`, "--auth-root-authentication-method=normal", "--skip-test-db", `--extra-file=${root}/run/init.sql`,
      ...(context.account.switchUser ? [`--user=${context.account.user}`] : [])],
  });
  yield* host.files.remove("run/init.sql");
  if (created.code !== 0) {
    return yield* Effect.fail(refuse("install", `MariaDB could not initialize its data directory: ${(created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ")}`));
  }
  yield* host.files.write(marker, "initialized\n");
});

export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    const { root } = context.directories;
    yield* requireVersions(host);
    for (const directory of [...TEMPORARY_DIRECTORIES, place(context, "site").relative]) yield* host.files.mkdir(directory);
    yield* installSite(host, context);
    const configuration = (render: () => string) => Effect.try({
      try: render, catch: (error) => error instanceof RecipeError ? error : refuse("install", "A configuration file could not be generated."),
    });
    yield* host.files.write("php-fpm.conf", yield* configuration(() => phpFpmConfig(context)));
    yield* host.files.write("Caddyfile", yield* configuration(() => caddyfile(context)));
    // Refused here, with the tool's own words, rather than as a process that dies at start.
    const fpm = yield* host.run({ command: "php-fpm", args: ["-tt", "-y", `${root}/php-fpm.conf`], timeoutMs: 30_000 });
    if (fpm.code !== 0) return yield* Effect.fail(refuse("install", `The PHP-FPM configuration is not valid: ${(fpm.stderr || fpm.stdout).trim().split("\n").slice(-3).join(" ")}`));
    const caddy = yield* host.run({ command: "caddy", args: ["validate", "--config", `${root}/Caddyfile`, "--adapter", "caddyfile"], timeoutMs: 30_000 });
    if (caddy.code !== 0) return yield* Effect.fail(refuse("install", `The Caddy configuration is not valid: ${(caddy.stderr || caddy.stdout).trim().split("\n").slice(-3).join(" ")}`));
    yield* initializeDatabase(host, context);
    yield* host.progress({ phase: "install", message: "PrestaShop is installed." });
  }),

  start: (context) => Effect.sync((): ProcessPlan => {
    const { root, sockets } = context.directories;
    return {
      processes: [
        {
          name: "database", command: "mariadbd", env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 120_000 },
          args: [`--datadir=${place(context, "db").absolute}`, `--socket=${sockets}/mariadb.sock`, `--port=${context.ports.db}`, "--bind-address=127.0.0.1",
            `--pid-file=${root}/run/mariadb.pid`, `--log-error=${root}/run/mariadb.log`,
            // MariaDB refuses to run as root without this, and there is nothing sensible for it to guess.
            ...(context.account.switchUser ? [`--user=${context.account.user}`] : [])],
        },
        {
          name: "php-fpm", command: "php-fpm", env: {}, dependsOn: ["database"],
          args: ["-F", "-y", `${root}/php-fpm.conf`], readiness: { path: `${sockets}/php-fpm.sock`, timeoutMs: 120_000 },
          // A new pool configuration is picked up by PHP-FPM's graceful reload: workers finish their requests first.
          config: [`${root}/php-fpm.conf`], update: { strategy: "reload", signal: "SIGUSR2" },
        },
        {
          name: "caddy", command: "caddy", env: {}, dependsOn: ["php-fpm"],
          args: ["run", "--config", `${root}/Caddyfile`, "--adapter", "caddyfile", "--pidfile", `${root}/run/caddy.pid`], readiness: { port: "web", timeoutMs: 120_000 },
          // SIGUSR1 makes Caddy load the new configuration and let in-flight requests finish on the old one.
          config: [`${root}/Caddyfile`], update: { strategy: "reload", signal: "SIGUSR1" },
        },
      ],
    };
  }),
});
