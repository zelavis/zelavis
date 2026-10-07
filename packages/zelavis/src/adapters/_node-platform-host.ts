import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { join, resolve } from "node:path";
import { Deferred, Effect, Semaphore } from "effect";
import type { RuntimeRelease } from "../core/runtime/handover.js";
import { createRuntimeAdmission } from "../core/runtime/admission.js";
import { evaluate, integration, IntegrationFailure, type TaggedFailure } from "../core/runtime/effect-boundary.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import { createAgentProcessServer } from "./_agent-ipc.js";
import { createNodeRuntimeJournal } from "./_node-runtime-journal.js";
import { proveNodeRuntimeUnowned } from "./_node-runtime-ownership.js";
import { createNodeRuntimeSupervisor, type NodeRuntimeExecution } from "./_node-runtime-supervisor.js";
import { createNodeRuntimeIngress } from "./_node-runtime-ingress.js";
import { firstRoutableAddress } from "./_host-address.js";
import { loadOrCreatePlatformTls } from "./_platform-tls.js";

/** The only path the enrollment listener forwards to the engine. */
export const ENROLLMENT_PATH = "/zelavis/api/v1/runtime/nodes/enroll";
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
import { serveNodeRuntimeControl, NODE_RUNTIME_PREVIEW_ID, NODE_RUNTIME_PREVIEW_KEY } from "./_node-runtime-control.js";

/** Platform authority belongs to the selected engine. Its persistent host owns
 * HTTP admission, preview sockets, the writer journal and the stable Fabric
 * custody session, using the same engine supervisor as a Zelavis App host.
 */
export const createNodePlatformHost = Effect.fn("PlatformHost.create")(function* (options: {
  readonly dataDirectory: string;
  readonly host: string;
  readonly initial: RuntimeRelease;
  readonly environment: Readonly<Record<string, string>>;
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly resolve: (release: RuntimeRelease, configuration: Readonly<Record<string, unknown>>, environment: Readonly<Record<string, string>>) => Effect.Effect<NodeRuntimeExecution, TaggedFailure>;
  readonly select?: (version: string) => Effect.Effect<RuntimeRelease, TaggedFailure>;
  readonly versions?: Effect.Effect<Readonly<Record<string, unknown>>[], TaggedFailure>;
  readonly commit?: (release: RuntimeRelease, generation: number) => Effect.Effect<void, TaggedFailure>;
  readonly startupTimeoutMs?: number;
  readonly authorizedInitial?: boolean;
  readonly output?: (stream: "stdout" | "stderr", line: string) => void;
}) {
  const directory = resolve(options.dataDirectory), endpoint = join(directory, "runtime-control.sock");
  yield* evaluate(() => {
    const maximum = process.platform === "darwin" ? 103 : 107;
    const agentPath = join(options.environment.ZELAVIS_AGENT_ENDPOINT ?? join(directory, "runtime-agent"), "agent.sock");
    if ([endpoint, agentPath].some(path => Buffer.byteLength(path) > maximum)) throw new Error("Runtime data directory is too long for private control sockets; use a shorter absolute data directory.");
  });
  const token = randomBytes(32).toString("base64url");
  const journal = yield* createNodeRuntimeJournal(join(directory, "runtime-handover.json"));
  const recovered = yield* journal.recover(options.initial, proveNodeRuntimeUnowned(directory), options.authorizedInitial ? "authorized-initial" : "persisted");
  const admission = createRuntimeAdmission({ queueLimit: 1024 });
  yield* Effect.addFinalizer(() => admission.close);
  const engineAgent = yield* Effect.acquireRelease(Effect.sync(() => createLocalAgentProcessRunner({ stateDirectory: join(directory, "runtime-engines") })),
    runner => integration(() => runner.close()).pipe(Effect.orDie));
  let agentEndpoint = options.environment.ZELAVIS_AGENT_ENDPOINT;
  if (!agentEndpoint) {
    // Development/single-host custody stays outside replaceable engines.
    // Production installations use their separately supervised Agent unit.
    agentEndpoint = join(directory, "runtime-agent");
    const runner = yield* Effect.acquireRelease(Effect.sync(() => createLocalAgentProcessRunner({ stateDirectory: join(directory, "projects", ".agent-processes") })),
      runner => integration(() => runner.close()).pipe(Effect.orDie));
    yield* Effect.acquireRelease(integration(() => createAgentProcessServer({ directory: agentEndpoint!, runner })),
      server => integration(() => server.close()).pipe(Effect.orDie));
  }
  const custodyFile = join(directory, "runtime-custody.json");
  const custodyStat = yield* integration(() => lstat(custodyFile)).pipe(Effect.catchIf(error => (error.cause as { code?: string })?.code === "ENOENT", () => Effect.void));
  if (custodyStat) yield* evaluate(() => {
    if (!custodyStat.isFile() || custodyStat.isSymbolicLink() || custodyStat.size > 256 || custodyStat.uid !== process.getuid?.() || (custodyStat.mode & 0o077) !== 0) throw new Error("Fabric custody identity must be a bounded private file owned by this installation.");
  });
  const custodySource = custodyStat ? yield* integration(() => readFile(custodyFile, "utf8")) : undefined;
  const ownerSession = custodySource ? yield* evaluate(() => {
    if (custodySource.length > 256) throw new Error("Invalid persisted Fabric custody identity.");
    const value = JSON.parse(custodySource);
    if (value.protocol !== "zelavis-runtime/1" || typeof value.ownerSession !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.ownerSession)) throw new Error("Invalid persisted Fabric custody identity.");
    return value.ownerSession as string;
  }) : randomUUID();
  if (!custodySource) {
    const temporary = `${custodyFile}.${randomUUID()}`;
    yield* Effect.gen(function* () {
      yield* Effect.acquireUseRelease(integration(() => open(temporary, "wx", 0o600)), handle => Effect.gen(function* () {
        yield* integration(() => handle.writeFile(JSON.stringify({ protocol: "zelavis-runtime/1", ownerSession })));
        yield* integration(() => handle.sync());
      }), handle => integration(() => handle.close()).pipe(Effect.orDie));
      yield* integration(() => rename(temporary, custodyFile));
      if (process.platform !== "win32") yield* Effect.acquireUseRelease(integration(() => open(directory, "r")), handle => integration(() => handle.sync()), handle => integration(() => handle.close()).pipe(Effect.orDie));
    }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
  }
  const previews = new Map<string, ReturnType<typeof createNodeRuntimeIngress>>();
  const previewLifecycle = Semaphore.makeUnsafe(1), transitions = Semaphore.makeUnsafe(1);
  let handover = false, shuttingDown = false;
  let requireInventoryCommit = false;
  let inventoryCommit: { nonce: string; release: RuntimeRelease; generation: number; acknowledgement: Deferred.Deferred<void, TaggedFailure> } | undefined;
  let supervisor: Effect.Success<ReturnType<typeof createNodeRuntimeSupervisor>> | undefined;
  const headers = (projectId?: string) => Effect.fn("PlatformHost.ingressAuthority")(function* (input: import("node:http").IncomingHttpHeaders) {
    const sanitized = { ...input }; delete sanitized[NODE_RUNTIME_PREVIEW_ID]; delete sanitized[NODE_RUNTIME_PREVIEW_KEY];
    return () => Effect.sync(() => projectId ? { ...sanitized, [NODE_RUNTIME_PREVIEW_ID]: projectId, [NODE_RUNTIME_PREVIEW_KEY]: token } : sanitized);
  });
  const closePreviews = Effect.gen(function* () {
    yield* Effect.forEach([...previews.values()], listener => listener.close, { concurrency: 4, discard: true });
    previews.clear();
  });
  yield* Effect.addFinalizer(() => closePreviews.pipe(Effect.orDie));
  const replace = (release: RuntimeRelease) => transitions.withPermit(Effect.acquireUseRelease(
    evaluate(() => {
      if (!supervisor || shuttingDown) throw new Error("Platform host is not available for replacement.");
      handover = true;
    }), () => supervisor!.replace(release), () => Effect.sync(() => { handover = false; }),
  ));
  yield* serveNodeRuntimeControl(endpoint, Effect.fn("PlatformHost.control")(function* (input, authorization) {
    const previewCommand = input.action === "preview-open" || input.action === "preview-close";
    if (previewCommand) {
      yield* evaluate(() => {
        const supplied = Buffer.from(authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error("Engine preview authority required.");
        if (typeof input.projectId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(input.projectId)) throw new Error("Preview requires an exact Project identity.");
      });
      const projectId = input.projectId as string;
      return yield* previewLifecycle.withPermit(Effect.gen(function* () {
        if (input.action === "preview-close") {
          // Engine replacement releases handlers, never the persistent public
          // listener. Ordinary Project stop/delete still closes that listener.
          if (!handover && !shuttingDown) { const listener = previews.get(projectId); if (listener) yield* listener.close; previews.delete(projectId); }
          return { closed: true };
        }
        yield* evaluate(() => { if (!Number.isInteger(input.port) || Number(input.port) < 0 || Number(input.port) > 65535 || Number(input.port) > 0 && Number(input.port) < 1024) throw new Error("Invalid preview listener port."); });
        const current = previews.get(projectId);
        if (current) {
          const address = current.server.address();
          if (!address || typeof address === "string" || input.port !== 0 && address.port !== input.port) return yield* new IntegrationFailure(new Error("Saved preview port disagrees with persistent host custody."));
          return { port: address.port };
        }
        const listener = createNodeRuntimeIngress({ admission, target: () => supervisor?.target() ?? "", headers: headers(projectId) });
        const installation = options.configuration?.installation as { edge?: boolean } | undefined;
        const port = yield* listener.listen({ host: installation?.edge ? "0.0.0.0" : options.host, port: Number(input.port) }).pipe(Effect.onError(() => listener.close.pipe(Effect.ignore)));
        previews.set(projectId, listener); return { port };
      }));
    }
    if (authorization) return yield* new IntegrationFailure(new Error("Engine control token has no release-selection authority."));
    if (input.action === "status") {
      if (!supervisor) return { ready: false };
      const state = supervisor.snapshot();
      return { ready: true, protocol: "zelavis-runtime/1", supervisorPid: process.pid, release: state.release, generation: state.generation, requiresRecovery: state.requiresRecovery,
        cleanupFailures: state.cleanupFailures, admission: admission.snapshot(),
        ...(inventoryCommit ? { pendingCommit: { nonce: inventoryCommit.nonce, release: inventoryCommit.release, generation: inventoryCommit.generation } } : {}) };
    }
    if (input.action === "versions" && options.versions) return { versions: yield* options.versions };
    if (input.action === "select" && typeof input.version === "string" && options.select) {
      const selected = yield* options.select(input.version);
      // Installed callers acknowledge their receipt/current selection before
      // traffic resumes. Direct in-process tests use the host's commit binding.
      if (input.commit !== true) return yield* new IntegrationFailure(new Error("Installed selection requires an inventory commit acknowledgement."));
      return yield* transitions.withPermit(Effect.acquireUseRelease(
        Effect.sync(() => { requireInventoryCommit = true; handover = true; }),
        () => supervisor ? supervisor.replace(selected) : Effect.fail(new IntegrationFailure(new Error("Platform host is not ready."))),
        () => Effect.sync(() => { requireInventoryCommit = false; handover = false; }),
      ));
    }
    if (input.action === "commit") {
      const pending = inventoryCommit;
      if (!pending || input.nonce !== pending.nonce || input.version !== pending.release.version || input.generation !== pending.generation || typeof input.accepted !== "boolean")
        return yield* new IntegrationFailure(new Error("Inventory acknowledgement has no pending selection authority."));
      Deferred.doneUnsafe(pending.acknowledgement, input.accepted ? Effect.void : Effect.fail(new IntegrationFailure(new Error("Installer could not commit selected runtime inventory."))));
      return { accepted: true };
    }
    return yield* new IntegrationFailure(new Error("Unknown or unavailable Platform host operation."));
  }));
  // Machines join over TLS, authenticating the Platform by its pinned certificate. The
  // listener lives here, in the persistent host, so it survives engine replacement and
  // shares the engine's drain boundary; it forwards the enrollment route and nothing else.
  let enrollmentEndpoint: { readonly url: string; readonly fingerprint: string } | undefined;
  const enrollment = options.configuration?.enrollment as { readonly port?: unknown; readonly addresses?: unknown } | undefined;
  if (enrollment) {
    const port = enrollment.port;
    const requested = Array.isArray(enrollment.addresses) ? enrollment.addresses : [];
    yield* evaluate(() => {
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("The enrollment port must be from 1024 to 65535.");
      if (requested.length > 8 || requested.some(name => typeof name !== "string" || !(isIP(name) === 4 || HOSTNAME.test(name)))) throw new Error("Enrollment addresses must be IPv4 addresses or hostnames, at most 8.");
    });
    const detected = firstRoutableAddress();
    const names = (requested.length > 0 ? requested as string[] : [...(detected ? [detected] : []), "localhost"]);
    const tls = yield* loadOrCreatePlatformTls({ directory: join(directory, "enrollment-tls"), names }).pipe(
      Effect.mapError(error => new IntegrationFailure(error)));
    const listener = createNodeRuntimeIngress({ admission, target: () => supervisor?.target() ?? "", headers: headers(), tls,
      allowPath: path => path === ENROLLMENT_PATH });
    yield* Effect.addFinalizer(() => listener.close.pipe(Effect.orDie));
    const bound = yield* listener.listen({ host: "0.0.0.0", port: port as number });
    enrollmentEndpoint = { url: `https://${names[0]}:${bound}`, fingerprint: tls.fingerprint };
  }
  supervisor = yield* Effect.acquireRelease(createNodeRuntimeSupervisor({
    agent: engineAgent, workloadId: "platform", initial: recovered.release, generation: recovered.generation,
    admission, headers: headers(), startupTimeoutMs: options.startupTimeoutMs,
    resolve: selected => options.resolve(selected, { ...options.configuration, dataDirectory: directory, host: options.host, handover,
      ...(enrollmentEndpoint ? { enrollmentEndpoint } : {}),
      custody: { ownerSession, endpoint, token, preserveOnShutdown: Boolean(options.environment.ZELAVIS_AGENT_ENDPOINT) } }, { ...options.environment, ZELAVIS_AGENT_ENDPOINT: agentEndpoint! }),
    checkpoint: journal.checkpoint,
    commit: Effect.fn("PlatformHost.commit")(function* (release, generation) {
      if (options.commit) yield* options.commit(release, generation);
      if (requireInventoryCommit) yield* Effect.acquireUseRelease(Effect.sync(() => {
        const pending = { nonce: randomUUID(), release, generation, acknowledgement: Deferred.makeUnsafe<void, TaggedFailure>() };
        inventoryCommit = pending; return pending;
      }), pending => Deferred.await(pending.acknowledgement).pipe(Effect.timeoutOrElse({ duration: 30_000,
        orElse: () => Effect.fail(new IntegrationFailure(new Error("Installer inventory acknowledgement timed out."))),
      })), () => Effect.sync(() => { inventoryCommit = undefined; }));
      yield* journal.commit(release, generation);
    }),
    output: options.output,
  }), host => transitions.withPermit(Effect.gen(function* () {
    shuttingDown = true;
    yield* admission.close;
    yield* closePreviews;
    yield* host.close;
  })).pipe(Effect.orDie));
  return { listen: supervisor.listen, failure: supervisor.failure, replace, endpoint,
    snapshot: () => { const state = supervisor!.snapshot(); return { release: state.release, generation: state.generation,
      requiresRecovery: state.requiresRecovery, cleanupFailures: state.cleanupFailures, admission: admission.snapshot() }; },
  };
});
