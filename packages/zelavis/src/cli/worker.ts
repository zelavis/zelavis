import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { X509Certificate } from "node:crypto";
import { Data, Effect } from "effect";
import { integration, present } from "../core/runtime/effect-boundary.js";
import { generateAgentCertificate } from "../adapters/_agent-certificate.js";
import { firstRoutableAddress } from "../adapters/_host-address.js";
import { createPinnedFetch, normalizeFingerprint } from "../adapters/_pinned-fetch.js";
import { createZelavisClient, ZelavisClientHttpError } from "../sdk/fetch.js";
import { defaultCliDataDirectory } from "./data-directory.js";

const usage =
  "zelavis worker join --platform-url https://HOST[/zelavis] --node-id ID --enrollment-token TOKEN " +
  "[--platform-fingerprint sha256:HEX | --platform-ca-file FILE] [--address HOST_OR_IP]... [--port N] [--bind HOST] [--data-dir DIR] [--json]";

/** Where the worker keeps its identity and Agent configuration. */
export const WORKER_DIRECTORY = "worker";
const DEFAULT_AGENT_PORT = 8443;
const MAX_ADDRESSES = 8;

class WorkerUsageError extends Data.TaggedError("WorkerUsageError")<{ readonly message: string }> {}
class WorkerJoinError extends Data.TaggedError("WorkerJoinError")<{ readonly message: string }> {}

interface JoinArgs {
  readonly json: boolean;
  readonly help: boolean;
  readonly action: string | undefined;
  readonly platformUrl: string | undefined;
  readonly nodeId: string | undefined;
  readonly enrollmentToken: string | undefined;
  readonly fingerprint: string | undefined;
  readonly caFile: string | undefined;
  readonly addresses: readonly string[];
  readonly port: number;
  readonly bind: string;
  readonly dataDirectory: string;
}

const VALUE_FLAGS = [
  "--platform-url", "--node-id", "--enrollment-token", "--platform-fingerprint", "--platform-ca-file",
  "--address", "--port", "--bind", "--data-dir",
];

function parseJoinArgs(args: readonly string[]): JoinArgs {
  const positional: string[] = [];
  const values = new Map<string, string[]>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!VALUE_FLAGS.includes(flag)) throw new Error(`Unknown worker option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    values.set(flag, [...(values.get(flag) ?? []), value]);
  }
  const [action, ...rest] = positional;
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  for (const flag of VALUE_FLAGS.filter((name) => name !== "--address")) {
    if ((values.get(flag)?.length ?? 0) > 1) throw new Error(`${flag} may be given only once.`);
  }
  const one = (flag: string) => values.get(flag)?.[0];
  const port = one("--port");
  if (port !== undefined && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)) {
    throw new Error("--port must be a port number from 1 to 65535.");
  }
  const addresses = values.get("--address") ?? [];
  if (addresses.length > MAX_ADDRESSES) throw new Error(`At most ${MAX_ADDRESSES} --address values are allowed.`);
  return {
    json, help, action,
    platformUrl: one("--platform-url"), nodeId: one("--node-id"),
    enrollmentToken: one("--enrollment-token"), fingerprint: one("--platform-fingerprint"), caFile: one("--platform-ca-file"),
    addresses, port: port === undefined ? DEFAULT_AGENT_PORT : Number(port), bind: one("--bind") ?? "0.0.0.0",
    dataDirectory: resolve(one("--data-dir") ?? defaultWorkerDataDirectory()),
  };
}

/** A root worker keeps FHS state; anyone else keeps it beside their other Zelavis data. */
function defaultWorkerDataDirectory(): string {
  return process.getuid?.() === 0 ? "/var/lib/zelavis-worker" : `${defaultCliDataDirectory()}-worker`;
}

const need = (value: string | undefined, label: string) =>
  value ? Effect.succeed(value) : Effect.fail(new WorkerUsageError({ message: `${label} is required. ${usage}` }));

/** What a joined worker is, recorded once it has enrolled. */
interface WorkerIdentity {
  readonly nodeId: string;
  readonly agentId: string;
  readonly url: string;
  readonly certSha256: string;
  readonly platform: string;
  readonly joinedAt: string;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readIfPresent = (file: string) =>
  integration(() => readFile(file, "utf8")).pipe(
    Effect.map((text): string | undefined => text),
    Effect.catch((failure) =>
      (failure.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? Effect.succeed(undefined) : Effect.fail(failure)),
  );

/** Write beside the target, then rename: a reader never sees half a file. */
const writeAtomically = (file: string, content: string, mode: number) =>
  Effect.gen(function* () {
    const temporary = `${file}.${process.pid}.tmp`;
    yield* integration(() => writeFile(temporary, content, { mode }));
    yield* integration(() => chmod(temporary, mode));
    yield* integration(() => rename(temporary, file));
  });

/** A key file must be a regular, private file this user owns, never a link someone planted. */
const assertPrivateFile = (file: string) =>
  integration(() => lstat(file)).pipe(
    Effect.flatMap((stats) =>
      stats.isFile() && !stats.isSymbolicLink() && (stats.mode & 0o077) === 0
        ? Effect.void
        : Effect.fail(new WorkerJoinError({ message: `${file} must be a regular file readable only by its owner.` }))),
  );

const sha256Of = (certPem: string) => new X509Certificate(certPem).fingerprint256.replaceAll(":", "").toLowerCase();

const coveredNames = (certPem: string) =>
  (new X509Certificate(certPem).subjectAltName ?? "").split(", ").map((entry) => entry.replace(/^(DNS|IP Address):/, "").toLowerCase());

/**
 * `zelavis worker join`: make this machine a Node of an existing Platform.
 *
 * Host-local, so it has no HTTP route of its own; the enrollment it performs is
 * `POST /runtime/nodes/enroll`, which is. It generates the Agent's key and
 * certificate here (the key never leaves), authenticates the Platform before
 * sending the credential, enrolls, and writes the configuration
 * `zelavis agent --remote-project-config` reads.
 *
 * Retryable: key and certificate are kept, so a repeat after a crash or a lost
 * response enrolls the same certificate, which the Platform lets finish an
 * enrollment it already consumed the token for.
 */
export function runWorkerCommand(args: readonly string[]): Promise<void> {
  return present(Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseJoinArgs(args),
      catch: (error) => new WorkerUsageError({ message: error instanceof Error ? error.message : String(error) }),
    });
    if (parsed.help || !parsed.action) {
      console.log(usage);
      return;
    }
    if (parsed.action !== "join") {
      return yield* new WorkerUsageError({ message: `Unknown worker command "${parsed.action}". ${usage}` });
    }
    const platformUrl = yield* need(parsed.platformUrl, "--platform-url");
    const nodeId = yield* need(parsed.nodeId, "--node-id");
    const token = yield* need(parsed.enrollmentToken, "--enrollment-token");

    // Refuse before any network traffic: a credential must never cross a link that is not authenticated.
    const base = yield* Effect.try({
      try: () => new URL(platformUrl),
      catch: () => new WorkerUsageError({ message: "--platform-url is not a valid URL." }),
    });
    if (base.protocol !== "https:") {
      return yield* new WorkerUsageError({
        message: "The Platform must be reached over https so the enrollment credential and trust keys are authenticated. " +
          "Give the Platform a hostname with HTTPS first, or pin a self-signed certificate with --platform-fingerprint.",
      });
    }
    if (base.username || base.password || base.search || base.hash) {
      return yield* new WorkerUsageError({ message: "--platform-url must be an https origin with an optional path, and nothing else." });
    }
    if (parsed.fingerprint !== undefined && parsed.caFile !== undefined) {
      return yield* new WorkerUsageError({ message: "Choose --platform-fingerprint or --platform-ca-file, not both." });
    }
    if (parsed.fingerprint !== undefined && normalizeFingerprint(parsed.fingerprint) === undefined) {
      return yield* new WorkerUsageError({ message: "--platform-fingerprint must be a SHA-256 of 64 hex digits, optionally prefixed with sha256:." });
    }

    const addresses = parsed.addresses.length > 0 ? parsed.addresses : (() => {
      const detected = firstRoutableAddress();
      return detected === undefined ? [] : [detected];
    })();
    if (addresses.length === 0) {
      return yield* new WorkerUsageError({ message: "No routable address was found; give the address the Platform will use with --address." });
    }

    const directory = join(parsed.dataDirectory, WORKER_DIRECTORY);
    const keyFile = join(directory, "agent.key");
    const certFile = join(directory, "agent.crt");
    const trustFile = join(directory, "trust.json");
    const configFile = join(directory, "remote-project.json");
    const identityFile = join(directory, "identity.json");
    const agentUrl = `https://${addresses[0]!.includes(":") ? `[${addresses[0]}]` : addresses[0]}:${parsed.port}`;

    yield* integration(() => mkdir(directory, { recursive: true, mode: 0o700 }));
    yield* integration(() => chmod(directory, 0o700));

    // A machine joins one Platform as one node. Rejoining elsewhere is a deliberate fresh start.
    const recorded = yield* readIfPresent(identityFile);
    if (recorded !== undefined) {
      const identity: unknown = JSON.parse(recorded);
      if (isObject(identity) && identity.nodeId === nodeId && identity.url === agentUrl) {
        console.log(parsed.json ? JSON.stringify({ joined: true, ...identity, unchanged: true }, null, 2)
          : `This machine already joined as ${nodeId}. Start its Agent with:\n  zelavis agent --data-dir ${parsed.dataDirectory} --remote-project-config ${configFile}`);
        return;
      }
      return yield* new WorkerJoinError({
        message: `This machine already joined${isObject(identity) && typeof identity.nodeId === "string" ? ` as ${identity.nodeId}` : ""}. ` +
          `To join again, stop its Agent and remove ${directory}.`,
      });
    }

    // Reuse a key and certificate left by an earlier attempt, so a retry enrolls the same identity.
    let keyPem = yield* readIfPresent(keyFile);
    let certPem = yield* readIfPresent(certFile);
    if (keyPem !== undefined) yield* assertPrivateFile(keyFile);
    if ((keyPem === undefined) !== (certPem === undefined)) {
      return yield* new WorkerJoinError({ message: `${directory} holds only part of an earlier attempt; remove agent.key and agent.crt and retry.` });
    }
    if (certPem !== undefined) {
      const names = coveredNames(certPem);
      if (!addresses.every((address) => names.includes(address.toLowerCase()))) {
        return yield* new WorkerJoinError({ message: "An earlier attempt made a certificate for different addresses; remove agent.key and agent.crt and retry." });
      }
    } else {
      const generated = yield* Effect.try({
        try: () => generateAgentCertificate({ names: addresses }),
        catch: (error) => new WorkerUsageError({ message: error instanceof Error ? error.message : String(error) }),
      });
      keyPem = generated.keyPem;
      certPem = generated.certPem;
      yield* writeAtomically(keyFile, keyPem, 0o600);
      yield* writeAtomically(certFile, certPem, 0o644);
    }

    const caPem = parsed.caFile === undefined ? undefined : yield* integration(() => readFile(resolve(parsed.caFile!), "utf8"));
    const client = createZelavisClient({
      baseUrl: base.origin,
      rootPath: base.pathname === "/" ? "/zelavis" : base.pathname.replace(/\/+$/, ""),
      fetch: createPinnedFetch({
        ...(parsed.fingerprint === undefined ? {} : { fingerprint: parsed.fingerprint }),
        ...(caPem === undefined ? {} : { caPem }),
      }),
    });
    const enrolled = yield* integration(() => client.nodes.enroll({ nodeId, token, certPem: certPem!, url: agentUrl })).pipe(
      Effect.catch((failure) => {
        const cause = failure.cause;
        if (cause instanceof ZelavisClientHttpError) {
          return Effect.fail(new WorkerJoinError({
            message: cause.status === 403 ? "The Platform refused this enrollment. Check the node id and token, and that the token has not expired or been used."
              : cause.status === 409 ? "This Platform does not accept nodes yet. An operator must enable remote dispatch on it."
              : cause.status === 429 ? "The Platform is limiting enrollment attempts; wait a minute and retry."
              : `The Platform answered ${cause.status}: ${cause.message}`,
          }));
        }
        return Effect.fail(new WorkerJoinError({
          message: `Could not reach the Platform securely: ${cause instanceof Error ? cause.message : String(cause)}`,
        }));
      }),
    );

    // Configuration is written last: its presence means the machine is joined.
    yield* writeAtomically(trustFile, `${JSON.stringify(enrolled.trust, null, 2)}\n`, 0o644);
    yield* writeAtomically(configFile, `${JSON.stringify({
      host: parsed.bind, port: parsed.port, keyFile: "agent.key", certFile: "agent.crt", trustFile: "trust.json",
      agentId: enrolled.agentId, nodeId: enrolled.nodeId,
    }, null, 2)}\n`, 0o644);
    const identity: WorkerIdentity = {
      nodeId: enrolled.nodeId, agentId: enrolled.agentId, url: agentUrl, certSha256: sha256Of(certPem!),
      platform: base.origin, joinedAt: new Date().toISOString(),
    };
    yield* writeAtomically(identityFile, `${JSON.stringify(identity, null, 2)}\n`, 0o644);

    const start = `zelavis agent --data-dir ${parsed.dataDirectory} --remote-project-config ${configFile}`;
    console.log(parsed.json ? JSON.stringify({ joined: true, ...identity, configFile, trustFile, start }, null, 2)
      : `Joined ${base.origin} as ${enrolled.nodeId} (${enrolled.agentId}).\n` +
        `Start the Agent, and make sure ${parsed.bind === "0.0.0.0" ? "" : `${parsed.bind}:`}${parsed.port}/tcp is reachable from the Platform:\n  ${start}`);
  }));
}
