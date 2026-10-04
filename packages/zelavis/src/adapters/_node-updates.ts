import { IntegrationFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import { Deferred, Effect } from "effect";
import { integration, lifecycleGate, present, presentOperations, singleFlight } from "../core/runtime/effect-boundary.js";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  compareVersions,
  isExactVersion,
  parseUpdateRun,
  updateChannel,
  ZelavisUpdateRefusal,
  type ZelavisUpdateControl,
  type ZelavisUpdateStatus,
} from "../updates.js";

/** Where releases are published. The registry is the trust anchor for what a newer version is. */
export const UPDATE_DIST_TAGS_URL = "https://registry.npmjs.org/-/package/zelavis/dist-tags";

export const UPDATE_REQUEST_FILE = "request.json";
export const UPDATE_STATUS_FILE = "status.json";
/** An update that stopped reporting for this long is treated as failed, not as still running. */
const STALE_RUN_MS = 20 * 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const FRESH_CHECK_MS = 60 * 60_000;
const MAX_RESPONSE_BYTES = 4096;

export interface NodeUpdateControlOptions {
  /** The Platform's data directory; the updater and the Platform share `<data>/update`. */
  readonly dataDirectory: string;
  /** The version running now. Defaults to this package's own. */
  readonly currentVersion?: string;
  /** Injected for tests. */
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly url?: string;
  /** Injected for tests; defaults to this process's platform. */
  readonly platform?: string;
  /** `false` disables the periodic check (tests). */
  readonly schedule?: boolean;
  /** Starts the updater as this same user (user installations only); injected for tests. */
  readonly startUserUpdater?: (input: { prefix: string; runningRelease: string }) => void;
}

/** A user installation keeps its data in `<prefix>/data` beside a receipt that says so. */
function readUserInstallation(dataDirectory: string): { prefix: string; runningRelease: string } | undefined {
  try {
    const prefix = dirname(dataDirectory);
    const receipt = JSON.parse(readFileSync(join(prefix, "installation.json"), "utf8")) as { mode?: unknown; instance?: unknown; dataDirectory?: unknown };
    if (receipt.mode !== "user" || receipt.instance !== "default" || receipt.dataDirectory !== dataDirectory) return undefined;
    return { prefix, runningRelease: realpathSync(join(prefix, "current")) };
  } catch {
    return undefined;
  }
}

function startUpdaterAsUser({ prefix, runningRelease }: { prefix: string; runningRelease: string }): void {
  // Detached, so it outlives this request and, if the operator restarts Zelavis meanwhile, this process.
  const child = spawn(process.execPath, [join(prefix, "current", "platform", "dist", "cli.js"), "update", "--run", "--user"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ZELAVIS_RUNNING_RELEASE: runningRelease },
  });
  child.on("error", () => undefined);
  child.unref();
}

export function runningVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

const boundedJson = Effect.fn("Updates.boundedJson")(function* (response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return yield* new IntegrationFailure(new Error("The registry sent no body."));
  return yield* Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = yield* integration(() => reader.read());
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) return yield* new IntegrationFailure(new RangeError("The registry answered with more than expected."));
      chunks.push(value);
    }
    return yield* integration(() => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
  }).pipe(Effect.ensuring(integration(() => reader.cancel()).pipe(Effect.ignore)));
});

const channelVersion = Effect.fn("Updates.channelVersion")(function* (channel: "alpha" | "latest", options: { fetch?: typeof fetch; url?: string } = {}) {
  const response = yield* integration(signal => (options.fetch ?? fetch)(options.url ?? UPDATE_DIST_TAGS_URL, {
    headers: { accept: "application/json" }, redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  }), { interruptible: true });
  if (!response.ok) return yield* new IntegrationFailure(new Error(`The registry answered ${response.status}.`));
  const tags = (yield* boundedJson(response)) as Record<string, unknown>;
  const version = tags?.[channel];
  if (!isExactVersion(version)) return yield* new IntegrationFailure(new Error(`The registry lists no version for the ${channel} channel.`));
  return version;
});

/** The newest version published on a channel, by npm's own dist-tags. */
export function fetchChannelVersion(channel: "alpha" | "latest", options: { fetch?: typeof fetch; url?: string } = {}): Promise<string> {
  return present(channelVersion(channel, options));
}

/**
 * The Platform's half of updating: it checks what is newest and, when asked,
 * leaves a request for the root updater. It never touches the installation.
 */
export function createNodeUpdateControl(options: NodeUpdateControlOptions): ZelavisUpdateControl {
  const directory = join(options.dataDirectory, "update");
  const current = options.currentVersion ?? runningVersion();
  const channel = updateChannel(current);
  const now = options.now ?? Date.now;
  let latest: string | undefined;
  let checkedAt: number | undefined;
  let checkError: string | undefined;
  const checks = new Map<string, Deferred.Deferred<void, TaggedFailure>>();
  const applyGate = lifecycleGate();

  // The installer creates this folder for an installation it set up with the
  // updater, so its absence means this install cannot update itself.
  const user = readUserInstallation(options.dataDirectory);
  const unmanaged = (): string | undefined => {
    if (!channel) return "This build is not on a published update channel.";
    if (user) return undefined;
    if ((options.platform ?? process.platform) !== "linux") return "Only installations set up by the installer can update themselves.";
    if (!existsSync(directory)) return "This installation was not set up with the updater. Run the installer again to enable it.";
    return undefined;
  };

  const readState = Effect.fn("Updates.readState")(function* () {
    const [requested, run] = yield* Effect.all([
      integration(() => stat(join(directory, UPDATE_REQUEST_FILE))).pipe(Effect.map(() => true), Effect.orElseSucceed(() => false)),
      integration(() => readFile(join(directory, UPDATE_STATUS_FILE), "utf8")).pipe(
        Effect.flatMap(text => integration(() => parseUpdateRun(JSON.parse(text)))), Effect.orElseSucceed(() => undefined)),
    ] as const, { concurrency: 2 });
    const shown = run?.state === "running" && now() - Date.parse(run.startedAt) > STALE_RUN_MS
      ? { ...run, state: "failed" as const, message: "The update stopped reporting. Check the server's logs with: journalctl -u zelavis-update" }
      : run;
    return { requested, run: shown };
  });

  const status = Effect.fn("Updates.status")(function* (): Effect.fn.Return<ZelavisUpdateStatus, TaggedFailure> {
    const reason = unmanaged();
    const { requested, run } = yield* readState();
    const state = requested ? "requested" : run?.state ?? "idle";
    const restartRequired = run?.state === "succeeded" && run.to !== undefined && compareVersions(run.to, current) > 0;
    return {
      current, ...(channel ? { channel } : {}), ...(latest ? { latest } : {}),
      available: latest !== undefined && compareVersions(latest, current) > 0 && !(restartRequired && run?.to === latest),
      ...(checkedAt !== undefined ? { checkedAt: new Date(checkedAt).toISOString() } : {}),
      ...(checkError ? { checkError } : {}), managed: reason === undefined,
      ...(reason ? { unmanagedReason: reason } : {}), state,
      ...(run ? { run } : {}), ...(restartRequired ? { restartRequired } : {}),
    };
  });

  const check = Effect.fn("Updates.check")(function* () {
    if (channel) yield* singleFlight(checks, "registry", () => Effect.gen(function* () {
      const result = yield* Effect.result(channelVersion(channel, options));
      if (result._tag === "Success") { latest = result.success; checkError = undefined; }
      else checkError = result.failure.message;
      checkedAt = now();
    }));
    return yield* status();
  });

  // Only an installation set up with the updater checks on its own; tests and dev runs make no calls.
  if (options.schedule !== false && channel && (user || existsSync(directory))) {
    void present(check()).catch(() => undefined);
    setInterval(() => void present(check()).catch(() => undefined), CHECK_INTERVAL_MS).unref?.();
  }

  const apply = Effect.fn("Updates.apply")(function* (requestedBy: string) {
    return yield* applyGate("update", () => Effect.gen(function* () {
      const reason = unmanaged();
      if (reason) return yield* Effect.fail(new ZelavisUpdateRefusal("unmanaged", reason));
      let state = yield* status();
      if (state.state === "requested" || state.state === "running") return yield* Effect.fail(new ZelavisUpdateRefusal("busy", "An update is already in progress."));
      if (checkedAt === undefined || now() - checkedAt > FRESH_CHECK_MS) state = yield* check();
      if (state.latest === undefined) return yield* Effect.fail(new ZelavisUpdateRefusal("unchecked", state.checkError ?? "The newest version could not be looked up."));
      if (!state.available) return yield* Effect.fail(new ZelavisUpdateRefusal("up-to-date", "This installation is already on the newest version."));
      yield* integration(() => mkdir(directory, { recursive: true }));
      const file = join(directory, UPDATE_REQUEST_FILE);
      const temporary = `${file}.${randomUUID()}`;
      // The privileged updater chooses its own target; this request conveys no version or command.
      yield* Effect.gen(function* () {
        yield* integration(() => writeFile(temporary, `${JSON.stringify({ id: randomUUID(), requestedAt: new Date(now()).toISOString(), requestedBy: requestedBy.slice(0, 200) })}\n`, { mode: 0o600, flag: "wx" }));
        yield* integration(() => rename(temporary, file));
      }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
      if (user) yield* integration(() => (options.startUserUpdater ?? startUpdaterAsUser)(user));
      return yield* status();
    }));
  });
  return presentOperations({ status, check, apply });
}
