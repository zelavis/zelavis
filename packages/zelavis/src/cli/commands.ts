import { Cause, Effect } from "effect";
import { integration, IntegrationFailure, present, unwrapFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { assertInstallationInstance } from "../core/runtime/installation-instance.js";
import {
  bootstrapPlatformOwner,
  formatBootstrapStatus,
  readBootstrapStatus,
} from "./bootstrap.js";
import { runAgentCommand } from "./agent.js";
import { runAuthCommand } from "./auth.js";
import { describeInstallation, formatInstallation } from "./installation.js";
import { runPluginsCommand } from "./plugins.js";
import { runMarketplaceCommand } from "./marketplace.js";
import { runUpdateCommand } from "./update.js";
import { runProjectsCommand } from "./projects.js";
import { runNodesCommand } from "./nodes.js";
import { runWorkerCommand } from "./worker.js";
import { runSystemStoreCommand } from "./system-store.js";
import { runDataCommand } from "./data.js";
import { runHostOperationsCommand } from "./host-operations.js";
import { runEdgeCommand } from "./edge.js";
import { ZelavisClientHttpError } from "../sdk/fetch.js";
import { promptSecret, readAllStdin } from "./prompt.js";
import { runSetupWizard } from "./setup.js";
import {
  ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
  type ZelavisInstallationUninstaller,
  type ZelavisInstallationUninstallPlan,
} from "../core/runtime/installation.js";
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
  instance?: string;
  portExplicit?: boolean;
  dataExplicit?: boolean;
  hostExplicit?: boolean;
  host: string;
  port: number;
  dataDirectory?: string;
  /** Where the Platform finds and installs services; defaults to `<data>/services`. */
  servicesDirectory?: string;
}

export interface ZelavisCliRuntime {
  serve(options: ZelavisCliServeOptions): Promise<void>;
  install?(args: readonly string[]): Promise<void>;
  doctor?(args: readonly string[]): Promise<void>;
  createInstallationUninstaller?(options: {
    instance?: string;
    dataDirectory?: string;
  }):
    | ZelavisInstallationUninstaller
    | Promise<ZelavisInstallationUninstaller>;
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
  instance?: string;
  command?: string;
  target?: string;
  name?: string;
  host?: string;
  port?: number;
  dataDirectory?: string;
  servicesDirectory?: string;
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
  placementStore?: string;
  remoteProjectConfig?: string;
  platformAuthority?: string;
  operationCgroup?: string;
  operationMemoryMaxBytes?: number;
  operationPidsMax?: number;
  requireRootOwnedOperations: boolean;
  operationsOnly: boolean;
  endpointGroupAccess: boolean;
  passwordStdin: boolean;
  install: boolean;
  all: boolean;
  dryRun: boolean;
  json: boolean;
  confirmation?: string;
  help: boolean;
  version: boolean;
}

function printHelp(): void {
  console.log(`Zelavis CLI

Usage:
  zelavis system-store <namespaces|records NAMESPACE> [--limit N] [--after KEY] [--url URL] [--token TOKEN] [--json]
  zelavis plugins <namespace> <resource> <action> [--file input.json] [--url <url>] [--json]
  zelavis plugins [<namespace> [<resource>]] --help [--url <url>]
  zelavis serve [--instance <name>] [--host <host>] [--port <port>] [--data-dir <path>] [--services-dir <path>]
  zelavis install --from-release <path> | --from-npm <path> [--instance <name> --port <port>] [--user] [--dry-run]
  zelavis doctor [--instance <name>] [--user | --system] [--json]
  zelavis uninstall --all --dry-run [--data-dir <path>] [--json]
  sudo zelavis uninstall --all --confirm ${ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION} [--data-dir <path>] [--json]
  zelavis marketplace <allowlist|refresh> [--url <url>] [--token <token>] [--json]
  zelavis worker join --platform-url <https-url> --node-id <id> --enrollment-token <token> [--platform-fingerprint sha256:<hex> | --platform-ca-file <file>] [--address <host-or-ip>] [--port <port>] [--data-dir <path>] [--json]
  zelavis nodes <list|enroll-token|enroll|remove> [node-id] [--ttl-minutes N] [--replace] [--enrollment-token TOKEN --cert-file FILE --agent-url URL [--trust-out FILE]] [--url <url>] [--token <token>] [--json]
  zelavis update <status|check|apply> [--wait] [--url <url>] [--token <token>] [--json]
  zelavis projects <list|recipes|get|create|start|stop|restart|upgrade|logs|remove> [id|name] [--recipe <name>] [--id <id>] [--no-start] [--url <url>] [--token <token>] [--json]
  zelavis auth service-accounts <list|create|rotate|revoke> [account-id] [--name <name>] [--permission <permission>] [--project <id>] [--expires-days <days>] [--url <url>] [--token <token>] [--json]
  zelavis data <collections|create-collection|get|insert|update|delete|query|page|write> --project <id> [collection] [id] [--data <json>] [--where <json>] [--limit <n>] [--url <url>] [--token <token>] [--json]
  zelavis host-operations <catalog|submit|get|audit> [operation|id] [--version <v>] [--project <id>] [--arg name=value] [--json]
  zelavis edge <status|plan|switch> [adapter] [--publication <id>@<revision>] [--routes <n>] [--require <capability>] [--certificate-ref <ref>] [--url <url>] [--token <token>] [--json]
  zelavis services list [--url <url>]
  zelavis services sources [--url <url>] [--token <session-token>]
  zelavis services install <name> [--url <url>]
  zelavis services disable <name> [--url <url>]
  zelavis services register --specifier <specifier> [--name <name>] [--install] [--url <url>]
  zelavis setup [--url <url>] [--token <bootstrap-token>]
  zelavis bootstrap --email <email> [--display-name <name>] [--password-stdin] [--url <url>]
  zelavis bootstrap status [--url <url>]
  zelavis extensions [--for <service>] [--url <url>]
  zelavis agent [--data-dir <path>] [--operations-root <dir> --platform-authority <file>]
                [--placement-store <system-sqlite-file>]
                [--remote-project-config <file>]
                [--operation-cgroup delegated|<path>] [--operation-memory-max <bytes>]
                [--operation-pids-max <n>] [--require-root-owned-operations] [--operations-only] [--endpoint-group-access]

Commands:
  serve                     Run the long-lived Zelavis Platform OS.
  install                   Install a release on this host (no HTTP route).
  doctor                    Inspect local installation health without changes.
  uninstall                 Completely remove a packaged installation and all
                            Zelavis-owned data from this host. Local-only.
  setup                     Run the interactive first-install wizard.
  bootstrap                 Create the first Platform owner account.
  bootstrap status          Report whether an owner still has to be created.
  extensions                List services that extend another, by what they extend.
  agent                     Run the Zelavis Agent, which executes Project
                            processes. Supervise it yourself: it is meant to
                            outlive the Platform that drives it.
  edge                      Inspect, preflight, and safely switch the reverse
                            proxy behind the proxy-neutral Edge controller.
  marketplace               Show or refresh the marketplace allow-list.
  update                    Check for a newer version and update this installation
                            from its own dashboard route; status, check, apply.
  projects                  List, create, start, stop, restart, upgrade, remove and read
                            logs of Projects; recipes lists Project recipes.
  auth service-accounts     Create and revoke machine identities and rotate their
                            one-time Platform API tokens.
  services list             List runtime service registry entries.
  services sources          Inspect administrative source diagnostics as JSON.
  services install          Mark a registered service as installed.
  services disable          Mark an installed service as available.
  services register         Register an ESM service specifier.

Options:
  --host <host>             Listener host. Defaults to 127.0.0.1.
  --port <port>             Listener port. Defaults to 3000.
  --data-dir <path>         Platform data directory.
  --instance <name>        Select a local system installation (install/serve/doctor/uninstall).
  --services-dir <path>     Folder the Platform loads and installs services from.
                            Defaults to <data-dir>/services (or ZELAVIS_SERVICES_DIR).
  --url <url>               Zelavis root URL for endpoint-backed commands.
  --specifier <specifier>   ESM specifier for services register.
  --name <name>             Optional service name override.
  --source <source>         Service source: official or community.
  --order <number>          Service display order.
  --install                 Register the service as installed.
  --all                     Confirm the complete uninstall scope.
  --dry-run                 Print the complete uninstall plan without changing the host.
  --confirm <phrase>        Destructive uninstall acknowledgement.
                            Required phrase: ${ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION}
  --json                    Print machine-readable command output.
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
    operationsOnly: false,
    endpointGroupAccess: false,
    passwordStdin: false,
    install: false,
    all: false,
    dryRun: false,
    json: false,
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
    } else if (arg === "--all") {
      parsed.all = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--confirm") {
      parsed.confirmation = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--confirm=")) {
      parsed.confirmation = arg.slice("--confirm=".length);
    } else if (arg === "--instance" || arg.startsWith("--instance=")) {
      parsed.instance = arg.includes("=") ? arg.slice("--instance=".length) : readValue(args, index++, arg);
      assertInstallationInstance(parsed.instance);
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
    } else if (arg === "--services-dir") {
      parsed.servicesDirectory = readValue(args, index, arg);
      index += 1;
    } else if (arg.startsWith("--services-dir=")) {
      parsed.servicesDirectory = arg.slice("--services-dir=".length);
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
    } else if (arg === "--endpoint-group-access") {
      parsed.endpointGroupAccess = true;
    } else if (arg === "--operations-only") {
      parsed.operationsOnly = true;
    } else if (arg === "--require-root-owned-operations") {
      parsed.requireRootOwnedOperations = true;
    } else if (
      ["--operations-root", "--platform-authority", "--placement-store", "--remote-project-config", "--operation-cgroup", "--operation-memory-max", "--operation-pids-max"]
        .some((flag) => arg === flag || arg.startsWith(`${flag}=`))
    ) {
      const separator = arg.indexOf("=");
      const flag = separator === -1 ? arg : arg.slice(0, separator);
      const value = separator === -1 ? readValue(args, index, arg) : arg.slice(separator + 1);
      if (separator === -1) index += 1;
      if (flag === "--operations-root") parsed.operationsRoot = value;
      if (flag === "--placement-store") parsed.placementStore = value;
      if (flag === "--remote-project-config") parsed.remoteProjectConfig = value;
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

function formatUninstallPlan(plan: ZelavisInstallationUninstallPlan): string {
  const lines = [
    "Complete Zelavis uninstall plan:",
    ...plan.targets.map((target) => {
      const location = target.path ? ` (${target.path})` : "";
      const absence = target.exists === false ? " [already absent]" : "";
      return `  - ${target.description}${location}${absence}`;
    }),
    "",
    "Intentionally retained:",
    ...plan.retained.map((entry) => `  - ${entry}`),
  ];
  return lines.join("\n");
}

const refuse = (message: string) => new IntegrationFailure(new Error(message));

const runServicesCommand = Effect.fn("CLI.services")(function* (parsed: ParsedArgs): Effect.fn.Return<void, TaggedFailure> {
  const clientOptions = {
    url: parsed.url,
    headers: parsed.token ? { authorization: `Bearer ${parsed.token}` } : undefined,
  };
  if (parsed.target === "sources") {
    const sources = yield* integration(() => listRuntimeServiceSources(clientOptions));
    console.log(JSON.stringify({ sources }, null, 2));
    return;
  }
  if (parsed.target === "list") {
    const services = yield* integration(() => listRuntimeServices(clientOptions));
    console.log(formatRuntimeServiceList(services));
    return;
  }

  if (parsed.target === "install" || parsed.target === "enable") {
    if (!parsed.name) return yield* refuse("services install requires a service name.");
    const name = parsed.name;
    const result = yield* integration(() => updateRuntimeService(name, { status: "installed" }, clientOptions));
    console.log(`Installed ${name}.`);
    const activation = formatActivationResult(result.activation);
    if (activation) console.log(activation);
    return;
  }

  if (parsed.target === "disable" || parsed.target === "uninstall") {
    if (!parsed.name) return yield* refuse("services disable requires a service name.");
    const name = parsed.name;
    const result = yield* integration(() => updateRuntimeService(name, { status: "available" }, clientOptions));
    console.log(`Disabled ${name}.`);
    const activation = formatActivationResult(result.activation);
    if (activation) console.log(activation);
    return;
  }

  if (parsed.target === "register") {
    if (!parsed.specifier) return yield* refuse("services register requires --specifier.");
    const specifier = parsed.specifier;
    const result = yield* integration(() => registerRuntimeService(
      {
        specifier,
        name: parsed.name,
        source: parsed.source,
        order: parsed.order,
        status: parsed.install ? "installed" : "available",
      },
      clientOptions,
    ));
    const service = result.services.find((entry) => entry.name === parsed.name);
    console.log(`Registered ${service?.name ?? specifier}.`);
    const activation = formatActivationResult(result.activation);
    if (activation) console.log(activation);
    return;
  }

  return yield* refuse(`Unknown services command "${parsed.target ?? ""}". Expected list, sources, register, install, or disable.`);
});

// The provider Zelavis ships with. An installation that replaced it names
// its own with --provider.
const DEFAULT_BOOTSTRAP_PROVIDER = "password";

const resolveBootstrapPassword = Effect.fn("CLI.bootstrapPassword")(function* (parsed: ParsedArgs): Effect.fn.Return<string, TaggedFailure> {
  if (parsed.passwordStdin) {
    const piped = yield* integration(() => readAllStdin());
    if (!piped) return yield* refuse("--password-stdin was given but standard input was empty.");
    return piped;
  }

  const password = yield* integration(() => promptSecret("Owner password: "));
  const confirmation = yield* integration(() => promptSecret("Confirm password: "));
  if (password !== confirmation) return yield* refuse("The passwords did not match.");
  return password;
});

const runBootstrapCommand = Effect.fn("CLI.bootstrap")(function* (parsed: ParsedArgs): Effect.fn.Return<void, TaggedFailure> {
  if (parsed.target === "status") {
    console.log(formatBootstrapStatus(yield* integration(() => readBootstrapStatus({ url: parsed.url }))));
    return;
  }
  if (parsed.target) {
    return yield* refuse(`Unknown bootstrap command "${parsed.target}". Expected status, or no argument to create the owner.`);
  }

  const token = parsed.token ?? process.env.ZELAVIS_BOOTSTRAP_TOKEN;
  if (!token) {
    return yield* refuse("A bootstrap token is required. Set ZELAVIS_BOOTSTRAP_TOKEN on this machine or pass --token.");
  }
  if (!parsed.email && !parsed.username) return yield* refuse("bootstrap requires --email or --username.");

  // Checked before the password is asked for, so an operator is not made to
  // type a secret into a Platform that was never going to accept it.
  const status = yield* integration(() => readBootstrapStatus({ url: parsed.url }));
  if (!status.required) return yield* refuse("This Platform already has an owner.");
  const provider = parsed.provider ?? DEFAULT_BOOTSTRAP_PROVIDER;
  if (!status.enrollmentProviders.includes(provider)) {
    return yield* refuse(status.enrollmentProviders.length
      ? `No credential provider named "${provider}" is installed. Available: ${status.enrollmentProviders.join(", ")}.`
      : "This Platform has no credential provider installed, so no owner can be enrolled.");
  }

  const password = yield* resolveBootstrapPassword(parsed);
  const result = yield* integration(() => bootstrapPlatformOwner(
    {
      bootstrapToken: token,
      provider,
      password,
      ...(parsed.email ? { email: parsed.email } : {}),
      ...(parsed.username ? { username: parsed.username } : {}),
      ...(parsed.displayName ? { displayName: parsed.displayName } : {}),
    },
    { url: parsed.url },
  ));

  // The session token is deliberately not printed. It is a live owner
  // credential, and stdout is redirected into logs far too often.
  console.log(
    `Created Platform owner ${result.account.email ?? result.account.username ?? result.account.id}.`,
  );
  console.log("Sign in from the dashboard, or with the auth API, to continue.");
});

const runCliProgram = Effect.fn("CLI.dispatch")(function* (
  args: readonly string[] = process.argv.slice(2),
  options: ZelavisCliOptions = {},
): Effect.fn.Return<void, TaggedFailure> {
    if (args[0] === "plugins") {
      (yield* integration(() => runPluginsCommand(args.slice(1))));
      return;
    }
    if (args[0] === "projects") {
      (yield* integration(() => runProjectsCommand(args.slice(1))));
      return;
    }
    if (args[0] === "marketplace") {
      (yield* integration(() => runMarketplaceCommand(args.slice(1))));
      return;
    }
    if (args[0] === "worker") {
      (yield* integration(() => runWorkerCommand(args.slice(1))));
      return;
    }
    if (args[0] === "nodes") {
      (yield* integration(() => runNodesCommand(args.slice(1))));
      return;
    }
    if (args[0] === "update") {
      (yield* integration(() => runUpdateCommand(args.slice(1))));
      return;
    }
    if (args[0] === "auth") {
      (yield* integration(() => runAuthCommand(args.slice(1))));
      return;
    }
    if (args[0] === "system-store") {
      yield* integration(() => runSystemStoreCommand(args.slice(1)));
      return;
    }
    if (args[0] === "data") {
      (yield* integration(() => runDataCommand(args.slice(1))));
      return;
    }
    if (args[0] === "host-operations") {
      (yield* integration(() => runHostOperationsCommand(args.slice(1))));
      return;
    }
    if (args[0] === "edge") {
      (yield* integration(() => runEdgeCommand(args.slice(1))));
      return;
    }
    if (args[0] === "doctor") {
      if (args.includes("--help") || args.includes("-h")) {
        console.log("zelavis doctor [--instance <name>] [--user | --system] [--json]\nRead-only host inspection; no HTTP endpoint.");
        return;
      }
      if (!options.runtime?.doctor) return yield* new IntegrationFailure(new Error("Doctor requires the local host adapter."));
      (yield* integration(() => options.runtime!.doctor!(args.slice(1))));
      return;
    }
    if (args[0] === "install") {
      if (args.includes("--help") || args.includes("-h")) {
        console.log("zelavis install (--from-release <absolute path> | --from package --version <exact version>) [--instance <name> --port <port>] [--user] [--dry-run] [--json] [--force] [--public] [--allow-downgrade]\nHost-local only; no HTTP endpoint.");
        return;
      }
      if (!options.runtime?.install) return yield* new IntegrationFailure(new Error("Install requires the local host adapter."));
      (yield* integration(() => options.runtime!.install!(args.slice(1))));
      return;
    }
    const parsed = parseArgs(args);
    if (parsed.instance && !["serve", "uninstall"].includes(parsed.command ?? "")) return yield* new IntegrationFailure(new Error("--instance selects local installation lifecycle commands. Use --url for endpoint-backed commands."));

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
        return yield* new IntegrationFailure(new Error(
          "The serve command is provided by the public zelavis Platform package.",
        ));
      }
      (yield* integration(() => options.runtime!.serve({
        ...(parsed.instance ? { instance: parsed.instance } : {}),
        ...(parsed.instance || parsed.host !== undefined || parsed.port !== undefined || parsed.dataDirectory !== undefined ? { dataExplicit: parsed.dataDirectory !== undefined, portExplicit: parsed.port !== undefined, hostExplicit: parsed.host !== undefined } : {}),
        host: parsed.host ?? process.env.HOST ?? "127.0.0.1",
        port: parsed.port ?? parsePort(process.env.PORT ?? "3000"),
        dataDirectory: parsed.dataDirectory ?? process.env.ZELAVIS_DATA_DIR,
        ...((parsed.servicesDirectory ?? process.env.ZELAVIS_SERVICES_DIR)
          ? { servicesDirectory: (parsed.servicesDirectory ?? process.env.ZELAVIS_SERVICES_DIR)! }
          : {}),
      })));
      return;
    }
    if (parsed.command === "uninstall") {
      if (!parsed.all) {
        return yield* new IntegrationFailure(new Error(
          "Complete uninstall requires --all because it permanently deletes every Zelavis Project and all Platform data.",
        ));
      }
      if (!options.runtime?.createInstallationUninstaller) {
        return yield* new IntegrationFailure(new Error(
          "Complete uninstall is available only from a packaged Zelavis installation on a supported host adapter.",
        ));
      }
      const uninstaller = (yield* integration(() => options.runtime!.createInstallationUninstaller!({
        ...(parsed.instance ? { instance: parsed.instance } : {}),
        dataDirectory:
          parsed.dataDirectory ?? (parsed.instance ? undefined : process.env.ZELAVIS_DATA_DIR),
      })));
      if (parsed.dryRun) {
        const plan = (yield* integration(() => uninstaller.plan()));
        console.log(
          parsed.json
            ? JSON.stringify({ dryRun: true, plan }, null, 2)
            : `${formatUninstallPlan(plan)}\n\nNo changes were made.`,
        );
        return;
      }
      if (!parsed.confirmation) {
        return yield* new IntegrationFailure(new Error(
          `Complete uninstall requires --confirm ${ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION}. Run with --dry-run first.`,
        ));
      }
      const result = (yield* integration(() => uninstaller.uninstall({
        confirmation: parsed.confirmation!,
      })));
      console.log(
        parsed.json
          ? JSON.stringify(result, null, 2)
          : result.output ??
              "Zelavis installation, configuration and data removed.",
      );
      return;
    }
    if (parsed.command === "extensions") {
      console.log(
        formatRuntimeExtensions(
          (yield* integration(() => listRuntimeExtensions({
            url: parsed.url,
            ...(parsed.forService ? { owner: parsed.forService } : {}),
          }))),
        ),
      );
      return;
    }
    if (parsed.command === "agent") {
      const env = process.env;
      const operationsRoot = parsed.operationsRoot ?? env.ZELAVIS_AGENT_OPERATIONS_ROOT;
      const operationCgroup = parsed.operationCgroup ?? env.ZELAVIS_AGENT_OPERATION_CGROUP;
      const platformAuthority = parsed.platformAuthority ?? env.ZELAVIS_AGENT_PLATFORM_AUTHORITY;
      const placementStore = parsed.placementStore ?? env.ZELAVIS_AGENT_PLACEMENT_STORE;
      const remoteProjectConfig = parsed.remoteProjectConfig ?? env.ZELAVIS_AGENT_REMOTE_PROJECT_CONFIG;
      (yield* integration(() => runAgentCommand({
        operationsOnly: parsed.operationsOnly,
        endpointGroupAccess: parsed.endpointGroupAccess,
        ...(parsed.dataDirectory ?? process.env.ZELAVIS_DATA_DIR
          ? {
              dataDirectory: (parsed.dataDirectory ??
                process.env.ZELAVIS_DATA_DIR) as string,
            }
          : {}),
        ...(operationsRoot ? { operationsRoot } : {}),
        ...(platformAuthority ? { platformAuthority } : {}),
        ...(placementStore ? { placementStore } : {}),
        ...(remoteProjectConfig ? { remoteProjectConfig } : {}),
        ...(operationCgroup ? { operationCgroup } : {}),
        ...(parsed.operationMemoryMaxBytes !== undefined
          ? { operationMemoryMaxBytes: parsed.operationMemoryMaxBytes }
          : {}),
        ...(parsed.operationPidsMax !== undefined ? { operationPidsMax: parsed.operationPidsMax } : {}),
        requireRootOwnedOperations:
          parsed.requireRootOwnedOperations || env.ZELAVIS_AGENT_REQUIRE_ROOT_OWNED_OPERATIONS === "1",
      })));
      return;
    }
    if (parsed.command === "bootstrap") {
      yield* runBootstrapCommand(parsed);
      return;
    }
    if (parsed.command === "setup") {
      if (parsed.target) {
        return yield* new IntegrationFailure(new Error("setup does not accept positional arguments."));
      }
      (yield* integration(() => runSetupWizard({
        url: parsed.url,
        bootstrapToken: parsed.token,
      })));
      return;
    }
    if (parsed.command === "services") {
      yield* runServicesCommand(parsed);
      return;
    }
    return yield* new IntegrationFailure(new Error(`Unknown command "${parsed.command}".`));

});
export function runCli(
  args: readonly string[] = process.argv.slice(2),
  options: ZelavisCliOptions = {},
): Promise<void> {
  return present(runCliProgram(args, options).pipe(Effect.catchCause(cause => Effect.sync(() => {
    const error = unwrapFailure(Cause.squash(cause));
    if (args[0] === "plugins" || args.includes("--json")) {
      console.error(JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof ZelavisClientHttpError ? { status: error.response.status, details: error.body } : {}),
      }));
    } else {
      console.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }))));
}
