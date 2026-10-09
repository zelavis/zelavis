import { Effect } from "effect";
import { RecipeError, RecipeHost, defineRecipe, type ProcessPlan, type RecipeContext, type RecipeHostApi } from "zelavis/recipe";

/**
 * WordPress as a recipe: what to install and what to run, and nothing about the machine.
 *
 * Installing downloads the pinned release, writes the site's configuration and initializes a
 * dedicated MariaDB data directory. Starting returns the three processes of the stack (MariaDB,
 * PHP-FPM, Nginx) as a plan. The Platform finds the executables, allocates the ports, runs each
 * phase in a process of its own as the Project's OS user, starts and supervises the plan, and
 * resumes it after a restart.
 *
 * Layout below the Project's directory (`context.directories.root`): `site/` is WordPress,
 * `db/` the database, `run/` pid files and logs, the rest temporary space. Generated credentials
 * are secrets: this code names them and the host keeps them outside the Project.
 */

const MINIMUM_PHP: readonly [number, number] = [8, 2];
const MINIMUM_MARIADB: readonly [number, number] = [10, 6];
const REQUIRED_EXTENSIONS = ["curl", "dom", "fileinfo", "gd", "intl", "mbstring", "mysqli", "openssl", "xml", "zip"] as const;
const TEMPORARY_DIRECTORIES = ["tmp", "sessions", "run", "nginx-client-temp", "nginx-proxy-temp", "nginx-fastcgi-temp", "nginx-uwsgi-temp", "nginx-scgi-temp"] as const;
const SALTS = ["AUTH_KEY", "SECURE_AUTH_KEY", "LOGGED_IN_KEY", "NONCE_KEY", "AUTH_SALT", "SECURE_AUTH_SALT", "LOGGED_IN_SALT", "NONCE_SALT"] as const;
const DATABASE_NAME = "wordpress";
const DATABASE_USER = "wordpress";
const DATABASE_READY_MARKER = "db/.zelavis-initialized";

const refuse = (operation: string, message: string) => new RecipeError({ operation, message });

function versionAtLeast(text: string, minimum: readonly [number, number]): boolean {
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

const phpString = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;
const quoted = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const secretName = (salt: string) => `wp-${salt.toLowerCase().replaceAll("_", "-")}`;

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

[wordpress]
user = ${user}
group = ${group}
listen = ${sockets}/php-fpm.sock
; The socket is created by the PHP-FPM master, which is still root when the Platform is. Without
; these it lands root-owned and nginx's workers, which dropped to the same unprivileged account,
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
chdir = ${root}/site
catch_workers_output = yes
clear_env = yes
security.limit_extensions = .php
php_admin_value[upload_tmp_dir] = ${root}/tmp
php_admin_value[session.save_path] = ${root}/sessions
php_admin_value[error_log] = ${root}/run/php-errors.log
php_admin_flag[log_errors] = on
`;
}

function nginxConfig(context: RecipeContext): string {
  const { root, sockets } = context.directories;
  const web = context.ports.web;
  if (web === undefined) throw refuse("install", "The recipe needs a web port.");
  return `${context.account.switchUser ? `user ${context.account.user};\n` : ""}pid ${quoted(`${root}/run/nginx.pid`)};
error_log stderr notice;

events { worker_connections 1024; }

http {
  access_log ${quoted(`${root}/run/nginx-access.log`)};
  error_log ${quoted(`${root}/run/nginx-error.log`)};
  # Every temp path nginx may create, not only the ones this config uses. A path left unset falls
  # back to the prefix nginx was compiled with (/var/lib/nginx on Debian), which a Project's user
  # cannot write, and nginx creates the directory for every module it was built with.
  client_body_temp_path ${quoted(`${root}/nginx-client-temp`)};
  proxy_temp_path ${quoted(`${root}/nginx-proxy-temp`)};
  fastcgi_temp_path ${quoted(`${root}/nginx-fastcgi-temp`)};
  uwsgi_temp_path ${quoted(`${root}/nginx-uwsgi-temp`)};
  scgi_temp_path ${quoted(`${root}/nginx-scgi-temp`)};
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
    listen 127.0.0.1:${web};
    server_name _;
    root ${quoted(`${root}/site`)};
    index index.php index.html;

    location / {
      try_files $uri $uri/ /index.php?$args;
    }

    location ~ \\.php$ {
      try_files $uri =404;
      fastcgi_pass unix:${sockets}/php-fpm.sock;
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

const requireVersions = (host: RecipeHostApi) => Effect.gen(function* () {
  const php = yield* host.run({ command: "php", args: ["-r", "echo PHP_VERSION;"], timeoutMs: 30_000 });
  const fpm = yield* host.run({ command: "php-fpm", args: ["-v"], timeoutMs: 30_000 });
  if (php.code !== 0 || !versionAtLeast(php.stdout, MINIMUM_PHP) || !versionAtLeast(`${fpm.stdout} ${fpm.stderr}`, MINIMUM_PHP)) {
    return yield* Effect.fail(refuse("install", `WordPress needs PHP CLI and PHP-FPM ${MINIMUM_PHP.join(".")} or newer; found CLI ${php.stdout.trim()} and FPM ${fpm.stdout.trim().split("\n")[0] ?? ""}.`));
  }
  const extensions = yield* host.run({
    command: "php", timeoutMs: 30_000,
    args: ["-r", `$required=${JSON.stringify(REQUIRED_EXTENSIONS)}; echo json_encode(array_values(array_filter($required, fn($extension) => !extension_loaded($extension))));`],
  });
  const missing = yield* Effect.try({ try: () => JSON.parse(extensions.stdout) as unknown, catch: () => refuse("install", "PHP did not report its extensions.") });
  if (!Array.isArray(missing) || missing.length > 0) {
    return yield* Effect.fail(refuse("install", `WordPress is missing required PHP extensions: ${Array.isArray(missing) ? missing.join(", ") : "unknown"}.`));
  }
  const database = yield* host.run({ command: "mariadbd", args: ["--version"], timeoutMs: 30_000 });
  if (!versionAtLeast(`${database.stdout} ${database.stderr}`, MINIMUM_MARIADB)) {
    return yield* Effect.fail(refuse("install", `WordPress needs MariaDB ${MINIMUM_MARIADB.join(".")} or newer; found ${database.stdout.trim()}.`));
  }
});

const installSite = (host: RecipeHostApi, context: RecipeContext) => Effect.gen(function* () {
  if (!(yield* host.files.exists("site/wp-includes/version.php"))) {
    yield* host.progress({ phase: "install", message: `Downloading WordPress ${context.software.version}.` });
    yield* host.download({ url: context.software.archive, sha256: context.software.sha256, maxBytes: context.software.maxBytes, destination: "dl/wordpress.tar.gz" });
    // A half-extracted earlier attempt is replaced, not merged into.
    yield* host.files.remove("site");
    yield* host.extract("dl/wordpress.tar.gz", "site", { stripTopLevel: true });
    yield* host.files.remove("dl");
  }
  if (!(yield* host.files.exists("site/wp-config.php"))) {
    const password = yield* host.secret("db-password");
    const salts = yield* Effect.forEach(SALTS, (salt) => host.secret(secretName(salt)));
    yield* host.files.write("site/wp-config.php", [
      `<?php\ndefine('DB_NAME', '${phpString(DATABASE_NAME)}');\ndefine('DB_USER', '${phpString(DATABASE_USER)}');\ndefine('DB_PASSWORD', '`,
      password,
      `');\ndefine('DB_HOST', '127.0.0.1:${context.ports.db}');\ndefine('DB_CHARSET', 'utf8mb4');\ndefine('DB_COLLATE', '');\n`,
      ...SALTS.flatMap((salt, index) => [`define('${salt}', '`, salts[index]!, "');\n"]),
      `$table_prefix = 'wp_';\ndefine('WP_DEBUG', false);\nif (!defined('ABSPATH')) define('ABSPATH', __DIR__ . '/');\nrequire_once ABSPATH . 'wp-settings.php';\n`,
    ]);
  }
});

const initializeDatabase = (host: RecipeHostApi, context: RecipeContext) => Effect.gen(function* () {
  if (yield* host.files.exists(DATABASE_READY_MARKER)) return;
  yield* host.progress({ phase: "install", message: "Initializing the database." });
  const password = yield* host.secret("db-password");
  const { root } = context.directories;
  // An earlier attempt that died partway left a data directory with nothing in it worth keeping.
  yield* host.files.remove("db");
  yield* host.files.mkdir("db");
  // The first FLUSH PRIVILEGES turns account management on: bootstrap runs without grant tables.
  yield* host.files.write("run/init.sql", [
    `FLUSH PRIVILEGES;\nCREATE DATABASE IF NOT EXISTS \`${DATABASE_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`,
    `CREATE USER IF NOT EXISTS ${sqlString(DATABASE_USER)}@'127.0.0.1' IDENTIFIED BY '`, password, `';\n`,
    `GRANT ALL PRIVILEGES ON \`${DATABASE_NAME}\`.* TO ${sqlString(DATABASE_USER)}@'127.0.0.1';\nFLUSH PRIVILEGES;\n`,
  ]);
  const created = yield* host.run({
    command: "mariadb-install-db", timeoutMs: 10 * 60_000,
    args: [`--datadir=${root}/db`, "--auth-root-authentication-method=normal", "--skip-test-db", `--extra-file=${root}/run/init.sql`,
      ...(context.account.switchUser ? [`--user=${context.account.user}`] : [])],
  });
  yield* host.files.remove("run/init.sql");
  if (created.code !== 0) {
    return yield* Effect.fail(refuse("install", `MariaDB could not initialize its data directory: ${(created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ")}`));
  }
  yield* host.files.write(DATABASE_READY_MARKER, "initialized\n");
});

export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    const { root } = context.directories;
    yield* requireVersions(host);
    for (const directory of [...TEMPORARY_DIRECTORIES, "site"]) yield* host.files.mkdir(directory);
    yield* installSite(host, context);
    const configuration = (render: () => string) => Effect.try({
      try: render, catch: (error) => error instanceof RecipeError ? error : refuse("install", "A configuration file could not be generated."),
    });
    yield* host.files.write("php-fpm.conf", yield* configuration(() => phpFpmConfig(context)));
    yield* host.files.write("nginx.conf", yield* configuration(() => nginxConfig(context)));
    // Refused here, with the tool's own words, rather than as a process that dies at start.
    const fpm = yield* host.run({ command: "php-fpm", args: ["-tt", "-y", `${root}/php-fpm.conf`], timeoutMs: 30_000 });
    if (fpm.code !== 0) return yield* Effect.fail(refuse("install", `The PHP-FPM configuration is not valid: ${(fpm.stderr || fpm.stdout).trim().split("\n").slice(-3).join(" ")}`));
    const nginx = yield* host.run({ command: "nginx", args: ["-t", "-c", `${root}/nginx.conf`, "-p", root], timeoutMs: 30_000 });
    if (nginx.code !== 0) return yield* Effect.fail(refuse("install", `The Nginx configuration is not valid: ${(nginx.stderr || nginx.stdout).trim().split("\n").slice(-3).join(" ")}`));
    yield* initializeDatabase(host, context);
    yield* host.progress({ phase: "install", message: "WordPress is installed." });
  }),

  start: (context) => Effect.sync((): ProcessPlan => {
    const { root, sockets } = context.directories;
    return {
      processes: [
        {
          name: "database", command: "mariadbd", env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 120_000 },
          args: [`--datadir=${root}/db`, `--socket=${sockets}/mariadb.sock`, `--port=${context.ports.db}`, "--bind-address=127.0.0.1",
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
          name: "nginx", command: "nginx", env: {}, dependsOn: ["php-fpm"],
          args: ["-c", `${root}/nginx.conf`, "-p", root, "-g", "daemon off;"], readiness: { port: "web", timeoutMs: 120_000 },
          // SIGHUP makes nginx start workers on the new configuration and let the old ones drain.
          config: [`${root}/nginx.conf`], update: { strategy: "reload", signal: "SIGHUP" },
        },
      ],
    };
  }),
});
