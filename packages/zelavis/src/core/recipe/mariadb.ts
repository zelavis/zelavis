import { Effect } from "effect";
import { RecipeError, type ProcessPlan, type RecipeContext, type RecipeHostApi } from "./recipe.js";

/**
 * MariaDB for a recipe whose application keeps its data in it, written once for every such recipe.
 *
 * Two ways to run it, chosen by the install method the Project locked at creation, never by the host at
 * start: the method that runs `mariadbd` itself (the recipe's own pinned build where the vendor makes one,
 * otherwise the host's), and a method that declares a `database` container image and runs that through a
 * container engine. Either way the Project has its own server, data directory, port and credentials.
 */

export interface MariaDbSpec {
  /** The database and the account that owns it (the application's installer is given both). */
  readonly name: string;
  readonly user: string;
  /** The data directory, absolute: where the manifest's `directories` named it (`app/db`). */
  readonly data: { readonly absolute: string };
  /** The oldest server version the application supports, for the method that runs the host's or the recipe's build. */
  readonly minimum?: readonly [number, number];
}

type Process = ProcessPlan["processes"][number];

const refuse = (operation: string, message: string) => new RecipeError({ operation, message });
const sqlString = (value: string) => `'${value.replace(/'/g, "''")}'`;

const containerName = (context: RecipeContext) => `zv-${context.projectId}-database`;

/** The image this Project's method runs the database from, when it runs it in a container. */
export const databaseContainer = (context: RecipeContext): string | undefined =>
  "containers" in context.method ? context.method.containers?.database : undefined;

function versionAtLeast(text: string, minimum: readonly [number, number]): boolean {
  const match = text.match(/(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > minimum[0] || (major === minimum[0] && minor >= minimum[1]);
}

/** Refuses, with the tool's own words, a database that cannot run here. */
export const requireMariaDb = (host: RecipeHostApi, context: RecipeContext, spec: Pick<MariaDbSpec, "minimum">) => Effect.gen(function* () {
  if (databaseContainer(context) !== undefined) {
    const engine = yield* host.run({ command: "docker", args: ["version", "--format", "{{.Server.Version}}"], timeoutMs: 30_000 });
    if (engine.code !== 0) return yield* Effect.fail(refuse("install", "The container engine is installed but not running or not reachable by this account; start it and retry."));
    return;
  }
  const minimum = spec.minimum ?? [10, 6];
  const database = yield* host.run({ command: "mariadbd", args: ["--version"], timeoutMs: 30_000 });
  if (!versionAtLeast(`${database.stdout} ${database.stderr}`, minimum)) {
    return yield* Effect.fail(refuse("install", `This application needs MariaDB ${minimum.join(".")} or newer; found ${database.stdout.trim()}.`));
  }
});

/** Prepares the data directory and the database credentials, once. */
export const initializeMariaDb = (host: RecipeHostApi, context: RecipeContext, spec: MariaDbSpec) => Effect.gen(function* () {
  const password = yield* host.secret("db-password");
  const image = databaseContainer(context);
  if (image !== undefined) {
    // The image's own entrypoint creates the database and account on the first start from an empty directory.
    yield* host.progress({ phase: "install", message: "Fetching the database image." });
    const pulled = yield* host.run({ command: "docker", args: ["pull", "--quiet", image], timeoutMs: 15 * 60_000 });
    if (pulled.code !== 0) return yield* Effect.fail(refuse("install", `The database image could not be fetched: ${(pulled.stderr || pulled.stdout).trim().split("\n").slice(-2).join(" ")}`));
    yield* host.files.mkdir(spec.data.absolute);
    return;
  }
  const marker = `${spec.data.absolute}/.zelavis-initialized`;
  if (yield* host.files.exists(marker)) return;
  yield* host.progress({ phase: "install", message: "Initializing the database." });
  const { root } = context.directories;
  // An earlier attempt that died partway left a data directory with nothing in it worth keeping.
  yield* host.files.remove(spec.data.absolute);
  yield* host.files.mkdir(spec.data.absolute);
  // The first FLUSH PRIVILEGES turns account management on: bootstrap runs without grant tables.
  yield* host.files.write("run/init.sql", [
    `FLUSH PRIVILEGES;\nCREATE DATABASE IF NOT EXISTS \`${spec.name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;\n`,
    `CREATE USER IF NOT EXISTS ${sqlString(spec.user)}@'127.0.0.1' IDENTIFIED BY '`, password, `';\n`,
    `GRANT ALL PRIVILEGES ON \`${spec.name}\`.* TO ${sqlString(spec.user)}@'127.0.0.1';\nFLUSH PRIVILEGES;\n`,
  ]);
  const created = yield* host.run({
    command: "mariadb-install-db", timeoutMs: 10 * 60_000,
    args: [`--datadir=${spec.data.absolute}`, "--auth-root-authentication-method=normal", "--skip-test-db", `--extra-file=${root}/run/init.sql`,
      ...(context.account.switchUser ? [`--user=${context.account.user}`] : [])],
  });
  yield* host.files.remove("run/init.sql");
  if (created.code !== 0) {
    return yield* Effect.fail(refuse("install", `MariaDB could not initialize its data directory: ${(created.stderr || created.stdout).trim().split("\n").slice(-3).join(" ")}`));
  }
  yield* host.files.write(marker, "initialized\n");
});

/** The supervised database process of the plan, named `database`, ready when its `db` port accepts connections. */
export const mariaDbProcess = (context: RecipeContext, spec: MariaDbSpec): Process => {
  const { root, sockets } = context.directories;
  const image = databaseContainer(context);
  if (image !== undefined) {
    const { uid, gid } = context.account;
    if (uid === undefined || gid === undefined) throw refuse("start", "The container's database must run as this account, which this host cannot name numerically.");
    return {
      name: "database", command: "docker", dependsOn: [], readiness: { port: "db", timeoutMs: 300_000, greeting: true },
      // The password reaches the container through the engine client's own environment, never its arguments.
      env: { MARIADB_PASSWORD: { secret: "db-password" } },
      args: [
        "run", "--rm", "--name", containerName(context), "--user", `${uid}:${gid}`,
        "--publish", `127.0.0.1:${context.ports.db}:3306`, "--volume", `${spec.data.absolute}:/var/lib/mysql`,
        "--env", `MARIADB_DATABASE=${spec.name}`, "--env", `MARIADB_USER=${spec.user}`, "--env", "MARIADB_PASSWORD",
        // The administrator exists only inside the container: a connection through the published port is never "localhost" to it.
        "--env", "MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=1", "--env", "MARIADB_ROOT_HOST=localhost",
        image, "--character-set-server=utf8mb4", "--collation-server=utf8mb4_unicode_ci",
      ],
    };
  }
  return {
    name: "database", command: "mariadbd", env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 120_000, greeting: true },
    args: [`--datadir=${spec.data.absolute}`, `--socket=${sockets}/mariadb.sock`, `--port=${context.ports.db}`, "--bind-address=127.0.0.1",
      `--pid-file=${root}/run/mariadb.pid`, `--log-error=${root}/run/mariadb.log`,
      // MariaDB refuses to run as root without this, and there is nothing sensible for it to guess.
      ...(context.account.switchUser ? [`--user=${context.account.user}`] : [])],
  };
};

/**
 * After the Project's processes have been stopped (a stop, or its removal): a container whose client was
 * killed before it could stop it (a stop during the image's first initialization) is removed here, so the
 * name, the port and the data directory are free. Nothing to do for the method that runs the program itself.
 */
export const releaseMariaDb = (host: RecipeHostApi, context: RecipeContext) => Effect.gen(function* () {
  if (databaseContainer(context) === undefined) return;
  // Absent is the normal answer, so the exit code is not an error.
  yield* host.run({ command: "docker", args: ["rm", "--force", containerName(context)], timeoutMs: 60_000 });
});
