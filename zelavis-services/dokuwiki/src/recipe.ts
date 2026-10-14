import { Effect } from "effect";
import { RecipeError, RecipeHost, defineRecipe, type ProcessPlan, type RecipeContext, type RecipeHostApi } from "zelavis/recipe";

/**
 * DokuWiki as a recipe: a flat-file wiki served by Nginx and PHP-FPM, with no database.
 *
 * It is the second managed recipe of the Platform and deliberately different from WordPress in shape
 * (two processes, no credentials, no database to initialize) so that nothing in the recipe runtime,
 * the live upgrade or the integration depends on one application. Installing downloads the pinned
 * release (digest-checked) and validates the web configuration; DokuWiki's own installer, opened in
 * the browser, creates the administrator. Starting returns the two processes as a plan.
 *
 * Layout (manifest contract 2): the application alone is in `app/`, as its named directories: `site/` is DokuWiki (code,
 * `conf/` and `data/` are its own); the Platform's own files are in the root
 * (`context.directories.root`, `.zelavis/server`): server configuration, `run/` pid files and logs, temporary space.
 */

const MINIMUM_PHP: readonly [number, number] = [8, 2];
const REQUIRED_EXTENSIONS = ["mbstring", "xml"] as const;
const TEMPORARY_DIRECTORIES = ["tmp", "sessions", "run"] as const;

/** Where the Project keeps its site now, absolute, in app/. A newer recipe may name another path; the Platform moves the data at the next start from a stop. */
const place = (context: RecipeContext, name: "site") => {
  const absolute = context.directories.named[name];
  if (absolute === undefined) throw refuse("install", `The Platform did not provide the "${name}" directory.`);
  return { absolute };
};

const refuse = (operation: string, message: string) => new RecipeError({ operation, message });

function versionAtLeast(text: string, minimum: readonly [number, number]): boolean {
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

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

[dokuwiki]
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
	# DokuWiki keeps configuration, code and its own data below the document root; none of it is served.
	@denied path /data/* /conf/* /bin/* /inc/* /vendor/* /README /COPYING /VERSION /SECURITY.md
	respond @denied 403
	@hidden {
		path_regexp hidden ^/\\.
		not path /.well-known/*
	}
	respond @hidden 403
	php_fastcgi unix/${sockets}/php-fpm.sock {
		index doku.php
		try_files {path} {path}/doku.php
	}
	file_server
}
`;
}

const requireVersions = (host: RecipeHostApi) => Effect.gen(function* () {
  const php = yield* host.run({ command: "php", args: ["-r", "echo PHP_VERSION;"], timeoutMs: 30_000 });
  const fpm = yield* host.run({ command: "php-fpm", args: ["-v"], timeoutMs: 30_000 });
  if (php.code !== 0 || !versionAtLeast(php.stdout, MINIMUM_PHP) || !versionAtLeast(`${fpm.stdout} ${fpm.stderr}`, MINIMUM_PHP)) {
    return yield* Effect.fail(refuse("install", `DokuWiki needs PHP CLI and PHP-FPM ${MINIMUM_PHP.join(".")} or newer; found CLI ${php.stdout.trim()} and FPM ${fpm.stdout.trim().split("\n")[0] ?? ""}.`));
  }
  const extensions = yield* host.run({
    command: "php", timeoutMs: 30_000,
    args: ["-r", `$required=${JSON.stringify(REQUIRED_EXTENSIONS)}; echo json_encode(array_values(array_filter($required, fn($extension) => !extension_loaded($extension))));`],
  });
  const missing = yield* Effect.try({ try: () => JSON.parse(extensions.stdout) as unknown, catch: () => refuse("install", "PHP did not report its extensions.") });
  if (!Array.isArray(missing) || missing.length > 0) {
    return yield* Effect.fail(refuse("install", `DokuWiki is missing required PHP extensions: ${Array.isArray(missing) ? missing.join(", ") : "unknown"}.`));
  }
});

const installSite = (host: RecipeHostApi, context: RecipeContext) => Effect.gen(function* () {
  const site = place(context, "site").absolute;
  if (!(yield* host.files.exists(`${site}/doku.php`))) {
    yield* host.progress({ phase: "install", message: `Downloading DokuWiki ${context.software.version}.` });
    yield* host.download({ url: context.software.archive, sha256: context.software.sha256, maxBytes: context.software.maxBytes, destination: "dl/dokuwiki.tar.gz" });
    // A half-extracted earlier attempt is replaced, not merged into.
    yield* host.files.remove(site);
    yield* host.extract("dl/dokuwiki.tar.gz", site, { stripTopLevel: true });
    yield* host.files.remove("dl");
  }
});

export default defineRecipe({
  install: (context) => Effect.gen(function* () {
    const host = yield* RecipeHost;
    const { root } = context.directories;
    yield* requireVersions(host);
    for (const directory of [...TEMPORARY_DIRECTORIES, place(context, "site").absolute]) yield* host.files.mkdir(directory);
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
    yield* host.progress({ phase: "install", message: "DokuWiki is installed. Open the site to run its installer." });
  }),

  start: (context) => Effect.sync((): ProcessPlan => {
    const { root, sockets } = context.directories;
    return {
      processes: [
        {
          name: "php-fpm", command: "php-fpm", env: {}, dependsOn: [],
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
