import {
  bootstrapPlatformOwner,
  formatBootstrapStatus,
  readBootstrapStatus,
} from "./bootstrap.js";
import { runAgentCommand } from "./agent.js";
import { describeInstallation, formatInstallation } from "./installation.js";
import { runPluginsCommand } from "./plugins.js";
import { runProjectsCommand } from "./projects.js";
import { runHostOperationsCommand } from "./host-operations.js";
import { ZelavisClientHttpError } from "../sdk/fetch.js";
import { promptSecret, readAllStdin } from "./prompt.js";
import {
  formatActivationResult,
  formatRuntimeExtensions,
  listRuntimeExtensions,
  formatRuntimeServiceList,
  listRuntimeServices,
  listRuntimeServiceSources,
  registerRuntimeService,
  updateRuntimeService,
  type RuntimeServiceSource,
} from "./services.js";

export interface ZelavisCliServeOptions {
  host: string;
  port: number;
  dataDirectory?: string;
}

export interface ZelavisCliRuntime {
  serve(options: ZelavisCliServeOptions): Promise<void>;
}

export interface ZelavisCliOptions {
  runtime?: ZelavisCliRuntime;
  version?: string;
  /**
   * Real path of the running CLI entrypoint, symlinks resolved.
   *
   * Supplied by the binary rather than discovered here, so the CLI stays
   * testable without a filesystem. `--version` names the installation it
   * describes; see `./installation.js` for why that matters.
   */
  installationPath?: string;
}

interface ParsedArgs {
  command?: string;
  target?: string;
  name?: string;
  host?: string;
  port?: number;
  dataDirectory?: string;
  url?: string;
  specifier?: string;
  source?: RuntimeServiceSource;
  order?: number;
  email?: string;
  username?: string;
  displayName?: string;
  provider?: string;
  token?: string;
  forService?: string;
  operationsRoot?: string;
  operationTrust?: string;
  platformAuthority?: string;
  operationCgroup?: string;
  operationMemoryMaxBytes?: number;
  operationPidsMax?: number;
  requireRootOwnedOperations: boolean;
  passwordStdin: boolean;
  install: boolean;
  help: boolean;
  version: boolean;
}

function printHelp(): void {
  console.log(`Zelavis CLI

Usage:
  zelavis plugins <namespace> <resource> <action> [--file input.json] [--url <url>] [--json]
  zelavis plugins [<namespace> [<resource>]] --help [--url <url>]
  zelavis serve [--host <host>] [--port <port>] [--data-dir <path>]
  zelavis projects <list|recipes|get|create|start|stop|restart|logs|remove> [id|name] [--recipe <name>] [--id <id>] [--no-start] [--url <url>] [--token <token>] [--json]
  zelavis host-operations <catalog|submit|get|audit> [operation|id] [--version <v>] [--project <id>] [--arg name=value] [--json]
  zelavis services list [--url <url>]
  zelavis services sources [--url <url>] [--token <session-token>]
  zelavis services install <name> [--url <url>]
  zelavis services disable <name> [--url <url>]
  zelavis services register --specifier <specifier> [--name <name>] [--install] [--url <url>]
  zelavis bootstrap --email <email> [--display-name <name>] [--password-stdin] [--url <url>]
  zelavis bootstrap status [--url <url>]
  zelavis extensions [--for <service>] [--url <url>]
  zelavis agent [--data-dir <path>] [--operations-root <dir> --operation-trust <file> --platform-authority <file>]
                [--operation-cgroup delegated|<path>] [--operation-memory-max <bytes>]
                [--operation-pids-max <n>] [--require-root-owned-operations]

Commands:
  serve                     Run the long-lived Zelavis Platform OS.
  bootstrap                 Create the first Platform owner account.
  bootstrap status          Report whether an owner still has to be created.
  extensions                List services that extend another, by what they extend.
  agent                     Run the Zelavis Agent, which executes Project
                            processes. Supervise it yourself: it is meant to
                            outlive the Platform that drives it.
  projects                  List, create, start, stop, restart, remove and read
                            logs of Projects; recipes lists Project recipes.
  services list             List runtime service registry entries.
  services sources          Inspect administrative source diagnostics as JSON.
  services install          Mark a registered service as installed.
  services disable          Mark an installed service as available.
  services register         Register an ESM service specifier.

Options:
  --host <host>             Listener host. Defaults to 127.0.0.1.
  --port <port>             Listener port. Defaults to 3000.
  --data-dir <path>         Platform data directory.
  --url <url>               Zelavis root URL for endpoint-backed commands.
  --specifier <specifier>   ESM specifier for services register.
  --name <name>             Optional service name override.
  --source <source>         Service source: official or community.
  --order <number>          Service display order.
  --install                 Register the service as installed.
  --email <email>           Owner email address for bootstrap.
  --username <username>     Owner username, when not using an email identity.
  --display-name <name>     Owner display name.
  --provider <provider>     Credential provider. Defaults to password.
  --for <service>           Limit extensions to those extending this service.
  --token <token>           Bootstrap token for bootstrap; session token for services.
                            Bootstrap defaults to ZELAVIS_BOOTSTRAP_TOKEN.
  --password-stdin          Read the owner password from standard input.
  --version, -v             Print the CLI version and which installation it is.
  --help, -h                Show this help message.
`);
}

function readValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error("--port requires an integer between 1 and 65535.");
  }
  return port;
}

function parseOrder(value: string): number {
  const order = Number(value);
  if (!Number.isInteger(order) || order < 0) {
    throw new Error("--order requires a non-negative integer.");
  }
  return order;
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    requireRootOwnedOperations: false,
    passwordStdin: false,
    install: false,
    help: false,
    version: false,
  };
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--version" || arg === "-v") {
      parsed.version = true;
    } else if (arg === "--install") {
      parsed.install = true;
    } else if (arg === "--host") {
      parsed.host = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--host=")) {
      parsed.host = arg.slice("--host=".length);
    } else if (arg === "--port") {
      parsed.port = parsePort(readValue(args, index, arg));
      index += 1;
    } else if (arg.startsWith("--port=")) {
      parsed.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--data-dir") {
      parsed.dataDirectory = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--data-dir=")) {
      parsed.dataDirectory = arg.slice("--data-dir=".length);
    } else if (arg === "--url") {
      parsed.url = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--url=")) {
      parsed.url = arg.slice("--url=".length);
    } else if (arg === "--specifier") {
      parsed.specifier = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--specifier=")) {
      parsed.specifier = arg.slice("--specifier=".length);
    } else if (arg === "--name") {
      parsed.name = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--name=")) {
      parsed.name = arg.slice("--name=".length);
    } else if (arg === "--source") {
      const value = readValue(args, index, arg);
      if (value !== "official" && value !== "community") {
        throw new Error('--source must be "official" or "community".');
      }
      parsed.source = value;
      index += 1;
    } else if (arg.startsWith("--source=")) {
      const value = arg.slice("--source=".length);
      if (value !== "official" && value !== "community") {
        throw new Error('--source must be "official" or "community".');
      }
      parsed.source = value;
    } else if (arg === "--for") {
      parsed.forService = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--for=")) {
      parsed.forService = arg.slice("--for=".length);
    } else if (arg === "--require-root-owned-operations") {
      parsed.requireRootOwnedOperations = true;
    } else if (
      ["--operations-root", "--operation-trust", "--platform-authority", "--operation-cgroup", "--operation-memory-max", "--operation-pids-max"]
        .some((flag) => arg === flag || arg.startsWith(`${flag}=`))
    ) {
      const separator = arg.indexOf("=");
      const flag = separator === -1 ? arg : arg.slice(0, separator);
      const value = separator === -1 ? readValue(args, index, arg) : arg.slice(separator + 1);
      if (separator === -1) index += 1;
      if (flag === "--operations-root") parsed.operationsRoot = value;
      if (flag === "--operation-trust") parsed.operationTrust = value;
      if (flag === "--platform-authority") parsed.platformAuthority = value;
      if (flag === "--operation-cgroup") parsed.operationCgroup = value;
      if (flag === "--operation-memory-max" || flag === "--operation-pids-max") {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number <= 0) {
          throw new Error(`${flag} requires a positive integer.`);
        }
        if (flag === "--operation-memory-max") parsed.operationMemoryMaxBytes = number;
        else parsed.operationPidsMax = number;
      }
    } else if (arg === "--password-stdin") {
      parsed.passwordStdin = true;
    } else if (arg === "--password" || arg.startsWith("--password=")) {
      // Refused rather than ignored: silently dropping it would leave an
      // operator believing a password they leaked into shell history and the
      // process list had been accepted.
      throw new Error(
        "--password is not accepted because it leaks into shell history and the process list. Use --password-stdin or the interactive prompt.",
      );
    } else if (arg === "--email") {
      parsed.email = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--email=")) {
      parsed.email = arg.slice("--email=".length);
    } else if (arg === "--username") {
      parsed.username = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--username=")) {
      parsed.username = arg.slice("--username=".length);
    } else if (arg === "--display-name") {
      parsed.displayName = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--display-name=")) {
      parsed.displayName = arg.slice("--display-name=".length);
    } else if (arg === "--provider") {
      parsed.provider = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--provider=")) {
      parsed.provider = arg.slice("--provider=".length);
    } else if (arg === "--token") {
      parsed.token = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--token=")) {
      parsed.token = arg.slice("--token=".length);
    } else if (arg === "--order") {
      parsed.order = parseOrder(readValue(args, index, arg));
      index += 1;
    } else if (arg.startsWith("--order=")) {
      parsed.order = parseOrder(arg.slice("--order=".length));
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}".`);
    } else {
      positional.push(arg);
    }
  }

  parsed.command = positional[0];
  parsed.target = positional[1];
  parsed.name = parsed.name ?? positional[2];
  return parsed;
}

async function runServicesCommand(parsed: ParsedArgs): Promise<void> {
  const clientOptions = {
    url: parsed.url,
    headers: parsed.token ? { authorization: `Bearer ${parsed.token}` } : undefined,
  };
  if (parsed.target === "sources") {
    const sources = await listRuntimeServiceSources(clientOptions);
    console.log(JSON.stringify({ sources }, null, 2));
    return;
  }
  if (parsed.target === "list") {
    const services = await listRuntimeServices(clientOptions);
    console.log(formatRuntimeServiceList(services));
    return;
  }

  if (parsed.target === "install" || parsed.target === "enable") {
    if (!parsed.name) throw new Error("services install requires a service name.");
    const result = await updateRuntimeService(
      parsed.name,
      { status: "installed" },
      clientOptions,
    );
    console.log(`Installed ${parsed.name}.`);
    const activation = formatActivationResult(result.activation);
    if (activation) console.log(activation);
    return;
  }

  if (parsed.target === "disable" || parsed.target === "uninstall") {
    if (!parsed.name) throw new Error("services disable requires a service name.");
    const result = await updateRuntimeService(
      parsed.name,
      { status: "available" },
      clientOptions,
    );
    console.log(`Disabled ${parsed.name}.`);
    const activation = formatActivationResult(result.activation);
    if (activation) console.log(activation);
    return;
  }

  if (parsed.target === "register") {
    if (!parsed.specifier) throw new Error("services register requires --specifier.");
    const result = await registerRuntimeService(
      {
        specifier: parsed.specifier,
        name: parsed.name,
        source: parsed.source,
        order: parsed.order,
        status: parsed.install ? "installed" : "available",
      },
      clientOptions,
    );
    const service = result.services.find(
      (entry) => entry.name === parsed.name,
    );
    console.log(`Registered ${service?.name ?? parsed.specifier}.`);
    const activation = formatActivationResult(result.activation);
    if (activation) console.log(activation);
    return;
  }

  throw new Error(
    `Unknown services command "${parsed.target ?? ""}". Expected list, sources, register, install, or disable.`,
  );
}

// The provider Zelavis ships with. An installation that replaced it names
// its own with --provider.
const DEFAULT_BOOTSTRAP_PROVIDER = "password";

async function resolveBootstrapPassword(parsed: ParsedArgs): Promise<string> {
  if (parsed.passwordStdin) {
    const piped = await readAllStdin();
    if (!piped) {
      throw new Error("--password-stdin was given but standard input was empty.");
    }
    return piped;
  }

  const password = await promptSecret("Owner password: ");
  const confirmation = await promptSecret("Confirm password: ");
  if (password !== confirmation) {
    throw new Error("The passwords did not match.");
  }
  return password;
}

async function runBootstrapCommand(parsed: ParsedArgs): Promise<void> {
  if (parsed.target === "status") {
    console.log(formatBootstrapStatus(await readBootstrapStatus({ url: parsed.url })));
    return;
  }
  if (parsed.target) {
    throw new Error(
      `Unknown bootstrap command "${parsed.target}". Expected status, or no argument to create the owner.`,
    );
  }

  const token = parsed.token ?? process.env.ZELAVIS_BOOTSTRAP_TOKEN;
  if (!token) {
    throw new Error(
      "A bootstrap token is required. Set ZELAVIS_BOOTSTRAP_TOKEN on this machine or pass --token.",
    );
  }
  if (!parsed.email && !parsed.username) {
    throw new Error("bootstrap requires --email or --username.");
  }

  // Checked before the password is asked for, so an operator is not made to
  // type a secret into a Platform that was never going to accept it.
  const status = await readBootstrapStatus({ url: parsed.url });
  if (!status.required) {
    throw new Error("This Platform already has an owner.");
  }
  const provider = parsed.provider ?? DEFAULT_BOOTSTRAP_PROVIDER;
  if (!status.enrollmentProviders.includes(provider)) {
    throw new Error(
      status.enrollmentProviders.length
        ? `No credential provider named "${provider}" is installed. Available: ${status.enrollmentProviders.join(", ")}.`
        : "This Platform has no credential provider installed, so no owner can be enrolled.",
    );
  }

  const result = await bootstrapPlatformOwner(
    {
      bootstrapToken: token,
      provider,
      password: await resolveBootstrapPassword(parsed),
      ...(parsed.email ? { email: parsed.email } : {}),
      ...(parsed.username ? { username: parsed.username } : {}),
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    },
    { url: parsed.url },
  );

  // The session token is deliberately not printed. It is a live owner
  // credential, and stdout is redirected into logs far too often.
  console.log(
    `Created Platform owner ${result.account.email ?? result.account.username ?? result.account.id}.`,
  );
  console.log("Sign in from the dashboard, or with the auth API, to continue.");
}

export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  options: ZelavisCliOptions = {},
): Promise<void> {
  try {
    if (args[0] === "plugins") {
      await runPluginsCommand(args.slice(1));
      return;
    }
    if (args[0] === "projects") {
      await runProjectsCommand(args.slice(1));
      return;
    }
    if (args[0] === "host-operations") {
      await runHostOperationsCommand(args.slice(1));
      return;
    }
    const parsed = parseArgs(args);

    if (parsed.version) {
      // The bare version stays on its own first line, so anything parsing this
      // keeps working; the installation goes underneath it.
      console.log(options.version ?? "unknown");
      if (options.installationPath) {
        console.log(formatInstallation(describeInstallation(options.installationPath)));
      }
      return;
    }
    if (parsed.help || !parsed.command) {
      printHelp();
      return;
    }
    if (parsed.command === "serve") {
      if (!options.runtime) {
        throw new Error(
          "The serve command is provided by the public zelavis Platform package.",
        );
      }
      await options.runtime.serve({
        host: parsed.host ?? process.env.HOST ?? "127.0.0.1",
        port: parsed.port ?? parsePort(process.env.PORT ?? "3000"),
        dataDirectory: parsed.dataDirectory ?? process.env.ZELAVIS_DATA_DIR,
      });
      return;
    }
    if (parsed.command === "extensions") {
      console.log(
        formatRuntimeExtensions(
          await listRuntimeExtensions({
            url: parsed.url,
            ...(parsed.forService ? { owner: parsed.forService } : {}),
          }),
        ),
      );
      return;
    }
    if (parsed.command === "agent") {
      const env = process.env;
      const operationsRoot = parsed.operationsRoot ?? env.ZELAVIS_AGENT_OPERATIONS_ROOT;
      const operationTrust = parsed.operationTrust ?? env.ZELAVIS_AGENT_OPERATION_TRUST;
      const operationCgroup = parsed.operationCgroup ?? env.ZELAVIS_AGENT_OPERATION_CGROUP;
      const platformAuthority = parsed.platformAuthority ?? env.ZELAVIS_AGENT_PLATFORM_AUTHORITY;
      await runAgentCommand({
        ...(parsed.dataDirectory ?? process.env.ZELAVIS_DATA_DIR
          ? {
              dataDirectory: (parsed.dataDirectory ??
                process.env.ZELAVIS_DATA_DIR) as string,
            }
          : {}),
        ...(operationsRoot ? { operationsRoot } : {}),
        ...(operationTrust ? { operationTrust } : {}),
        ...(platformAuthority ? { platformAuthority } : {}),
        ...(operationCgroup ? { operationCgroup } : {}),
        ...(parsed.operationMemoryMaxBytes !== undefined
          ? { operationMemoryMaxBytes: parsed.operationMemoryMaxBytes }
          : {}),
        ...(parsed.operationPidsMax !== undefined ? { operationPidsMax: parsed.operationPidsMax } : {}),
        requireRootOwnedOperations:
          parsed.requireRootOwnedOperations || env.ZELAVIS_AGENT_REQUIRE_ROOT_OWNED_OPERATIONS === "1",
      });
      return;
    }
    if (parsed.command === "bootstrap") {
      await runBootstrapCommand(parsed);
      return;
    }
    if (parsed.command === "services") {
      await runServicesCommand(parsed);
      return;
    }
    throw new Error(`Unknown command "${parsed.command}".`);
  } catch (error) {
    if (args[0] === "plugins" || ((args[0] === "projects" || args[0] === "host-operations") && args.includes("--json"))) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ZelavisClientHttpError ? { status: error.response.status, details: error.body } : {}),
      }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
