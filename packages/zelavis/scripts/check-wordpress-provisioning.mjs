/**
 * Proves the native WordPress runtime installs what it needs.
 *
 * Everything else about WordPress has only ever been exercised on a host that
 * already had nginx, PHP and MariaDB, so the provisioning path — the half of
 * the promise that says an operator does not have to install anything — had
 * never actually run. This is the check that runs it, and it is a script rather
 * than a test because it only means something on a host that is missing those
 * packages and is allowed to install them. That is a container, not a laptop.
 *
 * It refuses to run anywhere else. A pass on a machine that already had the
 * packages would be worse than no check at all: it would look like evidence.
 */
import { access, mkdtemp, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNativeWordPressProjectRuntime } from "../dist/adapters/_native-wordpress-project-runtime.js";
import { WORDPRESS_VERSION } from "../dist/wordpress/index.js";

/**
 * What has to exist afterwards, and every name it may go by.
 *
 * Debian ships PHP-FPM as `php-fpm8.2` rather than a bare `php-fpm`, which the
 * driver already knows — its candidate list carries the versioned names. A
 * check that insisted on the unversioned one would report a failure the
 * Platform does not have.
 */
const REQUIRED_BINARIES = [
  { label: "nginx", candidates: ["nginx"] },
  {
    label: "php-fpm",
    candidates: ["php-fpm", "php-fpm8.5", "php-fpm8.4", "php-fpm8.3", "php-fpm8.2"],
  },
  { label: "mariadbd", candidates: ["mariadbd"] },
];

function run(command, args) {
  return new Promise((resolveRun) => {
    execFile(command, args, (error, stdout) => {
      resolveRun({ ok: !error, stdout: stdout?.trim() ?? "" });
    });
  });
}

async function present(binary) {
  const { ok } = await run("sh", ["-c", `command -v ${binary}`]);
  return ok;
}

async function anyPresent(candidates) {
  for (const candidate of candidates) {
    if (await present(candidate)) return candidate;
  }
  return undefined;
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const installed = [];
for (const binary of REQUIRED_BINARIES) {
  if (await anyPresent(binary.candidates)) installed.push(binary.label);
}

if (installed.length > 0) {
  console.error(
    `This check only means something on a host that is missing WordPress's ` +
      `dependencies, and this one already has: ${installed.join(", ")}. ` +
      `Run it in a container.`,
  );
  process.exit(2);
}

// Root, or able to become it without a prompt — the two shapes provisioning
// knows how to install packages in.
//
// Not root itself, deliberately. MariaDB refuses to run as root unless it is
// told which user to drop to, and the Platform has no business choosing one, so
// an installation that provisions runs as an ordinary user with package
// authority. That is also the safer arrangement, and it is the one the driver's
// `sudo -n apt-get` path was written for.
const asRoot = process.getuid?.() === 0;
const canSudo = !asRoot && (await run("sudo", ["-n", "true"])).ok;

if (!asRoot && !canSudo) {
  console.error(
    "Provisioning installs host packages, so this check needs package " +
      "authority: run it as a user with passwordless sudo, in a container.",
  );
  process.exit(2);
}
if (asRoot) {
  console.error(
    "Running as root: MariaDB refuses to start without being told which user " +
      "to drop to, so this check cannot distinguish a provisioning failure " +
      "from that. Run it as a user with passwordless sudo instead.",
  );
  process.exit(2);
}

console.log("Host is missing nginx, php-fpm and mariadbd. Starting a WordPress Project.");

const dataDirectory = await mkdtemp(join(tmpdir(), "zelavis-provisioning-"));
const projectsDirectory = join(dataDirectory, "projects");

// The driver directly rather than through the Platform's HTTP surface. What is
// being checked is provisioning, and the runtime's error-disclosure policy
// turns exactly the failure this exists to catch into "the request could not be
// completed" — which is right for a client and useless for a diagnosis.
const driver = createNativeWordPressProjectRuntime({
  directory: projectsDirectory,
  // Generous: this start includes an apt update, a package install, and a
  // WordPress download before anything begins listening.
  startupTimeoutMs: 600_000,
});

const recipe = {
  name: "zelavis/wordpress",
  title: "WordPress",
  version: WORDPRESS_VERSION,
  specifier: "zelavis/wordpress",
};
const project = {
  id: "provisioned",
  name: "provisioned",
  kind: "wordpress",
  runtimeKind: "native",
  recipe,
};

const started = Date.now();
let snapshot;
try {
  await driver.prepare(project, recipe);
  snapshot = await driver.start(project);
} catch (error) {
  fail(`the Project did not start: ${error instanceof Error ? error.message : String(error)}`);
  if (error?.cause) {
    console.error(`  cause: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`);
  }
}
const elapsed = Math.round((Date.now() - started) / 1000);

if (snapshot) {
  console.log(`Project started in ${elapsed}s: ${snapshot.url}`);
}

// The packages are the point. A Project that started without them would mean
// the check proved nothing about provisioning.
for (const binary of REQUIRED_BINARIES) {
  const found = await anyPresent(binary.candidates);
  if (found) {
    console.log(`  installed: ${found}`);
  } else {
    fail(`${binary.label} is still missing, so provisioning did not install it`);
  }
}

if (snapshot?.url) {
  const response = await fetch(snapshot.url, { redirect: "manual" }).catch((error) => error);
  if (response instanceof Error) {
    fail(`the site did not answer: ${response.message}`);
  } else {
    const location = response.headers.get("location") ?? "";
    // WordPress redirects to its installer only once wp-config exists and the
    // database is reachable; an unreachable database renders an error page
    // instead. The redirect is what proves the whole stack came up.
    if (response.status === 302 && location.includes("install.php")) {
      console.log(`  serving: ${response.status} -> ${location}`);
    } else {
      fail(`unexpected response ${response.status} ${location}`);
    }
  }
}

const logs = await driver.logs("provisioned").catch(() => []);
if (process.exitCode) {
  console.error("  last project output:");
  for (const entry of logs.slice(-15)) {
    console.error(`    [${entry.stream}] ${entry.message.slice(0, 220)}`);
  }
} else {
  console.log(`  project log lines: ${logs.length}`);
}

await driver.close();

// Where the driver actually extracts the release: inside the Project's own
// runtime directory, not a sibling of it.
const siteDirectory = join(projectsDirectory, "provisioned", ".zelavis", "wordpress");

await access(join(siteDirectory, "wp-settings.php")).then(
  () => console.log("  WordPress source is on disk"),
  () => fail("the WordPress release was not extracted"),
);

if (!process.exitCode) {
  const version = await readFile(
    join(siteDirectory, "wp-includes", "version.php"),
    "utf8",
  ).catch(() => "");
  const match = /\$wp_version = '([^']+)'/.exec(version);
  console.log(`\nPASS: provisioning installed WordPress ${match?.[1] ?? "(version unknown)"} from nothing.`);
}
