import { IntegrationFailure, unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installationInstanceScope } from "../core/runtime/installation-instance.js";
import { compareVersions, isExactVersion, updateChannel, type ZelavisUpdateRun } from "../updates.js";
import { UPDATE_REQUEST_FILE, UPDATE_STATUS_FILE } from "./_node-updates.js";
import { NODE_RUNTIME_PROTOCOL } from "./_node-runtime-protocol.js";
const LOG_LINES = 40;
export interface UpdateRunnerOptions {
    readonly prefix: string;
    readonly dataDirectory: string;
    /** Runs a command to completion; the combined output is kept for the log. */
    run(command: string, args: readonly string[]): Promise<{
        readonly code: number;
        readonly output: string;
    }>;
    /** The newest version on a channel, from the registry. */
    channelVersion(channel: "alpha" | "latest"): Promise<string>;
    /** Whether the Platform answers on this port. */
    healthy(port: number): Promise<boolean>;
    sleep(milliseconds: number): Promise<void>;
    now?: () => Date;
    /** The instance this updater serves; the default instance when omitted. */
    readonly instance?: string;
    /** Both modes select through the persistent runtime host; only system inventory requires root. */
    readonly mode?: "system" | "user";
    /** A release a running process was started from; never pruned. */
    readonly keepRelease?: string;
    /** How long a new release gets to answer before it is rolled back. */
    healthTimeoutMs?: number;
}
interface Receipt {
    readonly version: string;
    readonly port: number;
    readonly mode: string;
    readonly instance: string;
}
const readReceipt = Effect.fn("PlatformUpdate.readReceipt")(function* (prefix: string, instance: string, mode: "system" | "user"): Effect.fn.Return<Receipt, TaggedFailure> {
    const scope = installationInstanceScope(prefix, instance);
    const value = (yield* Effect.flatMap(integration(() => readFile(scope.receipt, "utf8")), value => evaluate(() => JSON.parse(value)))) as Partial<Receipt>;
    if (value.mode !== mode || value.instance !== instance || !isExactVersion(value.version) || !Number.isInteger(value.port)) {
        return yield* new IntegrationFailure(new Error(`This is not a ${mode} installation that can update itself.`));
    }
    return value as Receipt;
});
const writeStatus = Effect.fn("PlatformUpdate.writeStatus")(function* (directory: string, run: ZelavisUpdateRun): Effect.fn.Return<void, TaggedFailure> {
    yield* integration(() => mkdir(directory, { recursive: true }));
    const file = join(directory, UPDATE_STATUS_FILE);
    const temporary = `${file}.${randomUUID()}`;
    yield* Effect.gen(function* () {
        yield* integration(() => writeFile(temporary, `${JSON.stringify(run)}\n`, { mode: 0o644, flag: "wx" }));
        yield* integration(() => rename(temporary, file));
    }).pipe(Effect.ensuring(integration(() => rm(temporary, { force: true })).pipe(Effect.orDie)));
});
/** The installer prints the first-owner token on a fresh install; none of that belongs in a status file. */
function tail(output: string): string[] {
    return output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
        .map((line) => /token|password|secret/i.test(line) ? "[redacted]" : line)
        .slice(-LOG_LINES);
}
const release = Effect.fn("PlatformUpdate.release")(function* (prefix: string, instance: string): Effect.fn.Return<string, TaggedFailure> {
    return yield* integration(() => realpath(installationInstanceScope(prefix, instance).current));
});
const pruneReleases = Effect.fn("PlatformUpdate.pruneReleases")(function* (prefix: string, instance: string, previous: string, running?: string): Effect.fn.Return<void, TaggedFailure> {
    const keep = new Set<string>([previous, ...running ? [(yield* Effect.orElseSucceed(integration(() => realpath(running)), () => running))] : []]);
    for (const name of ["default", instance]) {
        const selected = yield* Effect.catch(release(prefix, name), Effect.fn("PlatformUpdate.recover")(function* () { return undefined; }));
        if (selected)
            keep.add(selected);
    }
    const instances = yield* Effect.catch(integration(() => readdir(join(prefix, "instances"))), Effect.fn("PlatformUpdate.recover")(function* () { return [] as string[]; }));
    for (const name of instances) {
        const selected = yield* Effect.catch(integration(() => realpath(join(prefix, "instances", name, "current"))), Effect.fn("PlatformUpdate.recover")(function* () { return undefined; }));
        if (selected)
            keep.add(selected);
    }
    const releases = join(prefix, "releases");
    for (const name of (yield* Effect.orElseSucceed(integration(() => readdir(releases)), () => [] as string[]))) {
        const path = join(releases, name);
        // Qualified engines are deliberately available versions, including
        // engines pinned by Projects. A Platform update has no authority to
        // remove those selections. This check only retains bytes; selection
        // still verifies the complete artifact through the runtime catalog.
        if (isExactVersion(name)) {
            const artifact = join(path, "runtime-artifact.json");
            const retained = yield* Effect.gen(function* () {
                const stats = yield* integration(() => lstat(artifact));
                if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024 * 1024) return false;
                const source = yield* integration(() => readFile(artifact, "utf8"));
                return yield* evaluate(() => {
                    const value = JSON.parse(source);
                    return value.version === name && value.metadata?.protocol === NODE_RUNTIME_PROTOCOL;
                });
            }).pipe(Effect.catchIf(error => (unwrapFailure(error) as NodeJS.ErrnoException)?.code === "ENOENT", () => Effect.succeed(false)));
            if (retained) continue;
        }
        if (!keep.has((yield* Effect.orElseSucceed(integration(() => realpath(path)), () => path))))
            yield* integration(() => rm(path, { recursive: true, force: true }));
    }
});
/**
 * Runs the update a request asked for. Host-local and root only: it replaces
 * the installed release, so it is never an HTTP route.
 *
 * It ignores what the request says beyond its existence. The target is the
 * newest version on the channel of the version that is running, from the
 * registry, and anything not newer is refused, so a request can only ever ask
 * for the update the operator could have run by hand.
 */
export const runUpdateProgram = Effect.fn("PlatformUpdate.runUpdate")(function* (options: UpdateRunnerOptions): Effect.fn.Return<ZelavisUpdateRun | undefined, TaggedFailure> {
    const directory = join(options.dataDirectory, "update");
    const requestFile = join(directory, UPDATE_REQUEST_FILE);
    const now = options.now ?? (() => new Date());
    const request = yield * Effect.result(integration(() => readFile(requestFile, "utf8")));
    if (request._tag === "Failure" && (unwrapFailure(request.failure) as NodeJS.ErrnoException).code === "ENOENT")
        return undefined;
    const id = request._tag === "Success" ? requestId(request.success) : randomUUID();
    // Consumed first, so a failure cannot make systemd run the same request again.
    yield* integration(() => rm(requestFile, { force: true }));
    const instance = options.instance ?? "default";
    const scope = installationInstanceScope(options.prefix, instance);
    const mode = options.mode ?? "system";
    const receipt = yield* readReceipt(options.prefix, instance, mode);
    const startedAt = now().toISOString();
    let run: ZelavisUpdateRun = { id, state: "running", from: receipt.version, startedAt, message: "Looking up the newest version." };
    yield* writeStatus(directory, run);
    const finish = Effect.fn("PlatformUpdate.step")(function* (state: ZelavisUpdateRun["state"], message: string, extra: Partial<ZelavisUpdateRun> = {}) {
        run = { ...run, ...extra, state, message, finishedAt: now().toISOString() };
        yield* writeStatus(directory, run);
        return run;
    });
    const channel = updateChannel(receipt.version);
    if (!channel)
        return yield* finish("failed", "This build is not on a published update channel.");
    const lookup = yield * Effect.result(integration(() => options.channelVersion(channel)));
    if (lookup._tag === "Failure")
        return yield* finish("failed", `The newest version could not be looked up: ${lookup.failure.message}`);
    const target = lookup.success;
    if (compareVersions(target, receipt.version) <= 0) {
        return yield* finish("succeeded", "Already on the newest version.", { to: receipt.version });
    }
    const previous = yield* release(options.prefix, instance);
    const script = join(previous, "platform", "dist", "installation-assets", "install.sh");
    run = { ...run, to: target, message: `Preparing ${target} while ${receipt.version} keeps serving.` };
    yield* writeStatus(directory, run);
    // Phase 1, prepare: the installer shipped inside the installed release fetches the pinned Node
    // and the exact package and lays the new release beside the current one. The running Platform
    // is not touched, so a failure here costs nothing and nobody notices the download.
    const prepared = yield* integration(() => options.run("sh", [script, "--version", target, "--stage-only", ...mode === "user" ? ["--user"] : []]));
    const log = tail(prepared.output);
    if (prepared.code !== 0) {
        return yield* finish("failed", `Could not prepare ${target}, so nothing was changed and ${receipt.version} is still running.`, { log });
    }
    // The persistent host retains listeners, drains accepted traffic and transfers
    // one writable owner. The installer acknowledges receipt/current selection
    // before admission resumes, including during rollback.
    const newRelease = join(options.prefix, "releases", target);
    run = { ...run, message: `Transferring engine ownership to ${target}.` };
    yield* writeStatus(directory, run);
    const node = join(newRelease, "runtime", "node", "bin", "node");
    const swapped = yield* integration(() => options.run(node, [join(newRelease, "platform", "dist", "cli.js"), "install", "--from-release", newRelease, "--installed-by", "script", ...scope.named ? ["--instance", instance] : [], ...mode === "user" ? ["--user"] : [], "--live"]));
    log.push(...tail(swapped.output));
    let failure: string | undefined = swapped.code === 0 ? undefined : `The installer stopped with an error (exit ${swapped.code}).`;
    if (!failure) {
        const deadline = Date.now() + (options.healthTimeoutMs ?? 90000);
        let healthy = false;
        while (Date.now() < deadline) {
            if ((yield* integration(() => options.healthy(receipt.port)))) {
                healthy = true;
                break;
            }
            yield* integration(() => options.sleep(2000));
        }
        if (!healthy)
            failure = `Version ${target} did not answer within ${Math.round((options.healthTimeoutMs ?? 90000) / 1000)} seconds.`;
    }
    if (!failure) {
        yield* Effect.catch(pruneReleases(options.prefix, instance, previous, options.keepRelease), Effect.fn("PlatformUpdate.recover")(function* () { return undefined; }));
        return yield* finish("succeeded", `Updated from ${receipt.version} to ${target}.`, { log: log.slice(-LOG_LINES) });
    }
    // The candidate installer owns the inventory transition in both directions.
    // Selecting the retained previous engine through it also restores that
    // engine's authored host assets before admission resumes.
    run = { ...run, message: `${failure} Going back to ${receipt.version}.`, log: log.slice(-LOG_LINES) };
    yield* writeStatus(directory, run);
    const selected = yield* Effect.catch(release(options.prefix, instance), Effect.fn("PlatformUpdate.recover")(function* () { return previous; }));
    if (selected !== previous) {
        const back = yield* integration(() => options.run(node, [join(newRelease, "platform", "dist", "cli.js"), "install", "--from-release", previous, "--allow-downgrade", "--installed-by", "script", ...scope.named ? ["--instance", instance] : [], ...mode === "user" ? ["--user"] : [], "--live"]));
        log.push(...tail(back.output));
    }
    // Only restart what is not already answering: a swap that failed before it began changed nothing.
    let restored = yield* integration(() => options.healthy(receipt.port));
    if (!restored && mode === "system") {
        yield* integration(() => options.run("systemctl", ["restart", scope.units[0]]));
        for (let attempt = 0; attempt < 20 && !restored; attempt += 1) {
            restored = (yield* integration(() => options.healthy(receipt.port)));
            if (!restored)
                yield* integration(() => options.sleep(2000));
        }
    }
    // The release that did not work is no use to anyone; keep it only when the rollback itself failed.
    if (restored)
        yield* Effect.catch(pruneReleases(options.prefix, instance, previous, options.keepRelease), Effect.fn("PlatformUpdate.recover")(function* () { return undefined; }));
    return yield* finish("rolled-back", restored
        ? `${failure} Rolled back to ${receipt.version}, which is running again.`
        : `${failure} Rolling back to ${receipt.version} did not bring it back; check the server with: journalctl -u ${scope.units[0]}`, { log: log.slice(-LOG_LINES) });
});
function requestId(text: string): string {
    try {
        const request = JSON.parse(text) as {
            id?: unknown;
        };
        return typeof request.id === "string" && request.id.length <= 128 ? request.id : randomUUID();
    }
    catch {
        return randomUUID();
    }
}

export function runUpdate(options: UpdateRunnerOptions): Promise<ZelavisUpdateRun | undefined> { return present(runUpdateProgram(options)); }
