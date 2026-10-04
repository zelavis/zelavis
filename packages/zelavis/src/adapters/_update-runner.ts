import { IntegrationFailure, unwrapFailure } from "../core/runtime/effect-boundary.js";
import type { TaggedFailure } from "../core/runtime/effect-boundary.js";
import { Effect } from "effect";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
import { randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { installationInstanceScope } from "../core/runtime/installation-instance.js";
import { compareVersions, isExactVersion, updateChannel, type ZelavisUpdateRun } from "../updates.js";
import { UPDATE_REQUEST_FILE, UPDATE_STATUS_FILE } from "./_node-updates.js";
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
    /** The systemd socket unit that holds the dashboard port; when it exists the swap is live. */
    readonly socketUnitFile: string;
    /** The instance this updater serves; the default instance when omitted. */
    readonly instance?: string;
    /**
     * `user` is an installation in the user's own home: no systemd and no one to restart it, so the update
     * selects the new release and the running Platform keeps serving until it is restarted.
     */
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
const runUpdateProgram = Effect.fn("PlatformUpdate.runUpdate")(function* (options: UpdateRunnerOptions): Effect.fn.Return<ZelavisUpdateRun | undefined, TaggedFailure> {
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
    // Phase 2, swap: the new release's own installer selects it and restarts once. With the
    // socket held by systemd that restart queues connections instead of refusing them; before
    // the socket exists (the first update after it was introduced) the full installer is used.
    const newRelease = join(options.prefix, "releases", target);
    if (mode === "user")
        return yield* swapUser(options, { directory, run, finish, log, newRelease, previous, target, from: receipt.version });
    const live = yield* exists(options.socketUnitFile);
    run = { ...run, message: live ? `Switching to ${target}.` : `Installing ${target}; this update restarts the service for a few seconds.` };
    yield* writeStatus(directory, run);
    const node = join(newRelease, "runtime", "node", "bin", "node");
    const swapped = yield* integration(() => options.run(node, [join(newRelease, "platform", "dist", "cli.js"), "install", "--from-release", newRelease, "--installed-by", "script", ...scope.named ? ["--instance", instance] : [], ...live ? ["--live"] : []]));
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
    // Put the previous release back. It is kept on disk and complete, so its own installer can
    // select it again from where it lies.
    run = { ...run, message: `${failure} Going back to ${receipt.version}.`, log: log.slice(-LOG_LINES) };
    yield* writeStatus(directory, run);
    const selected = yield* Effect.catch(release(options.prefix, instance), Effect.fn("PlatformUpdate.recover")(function* () { return previous; }));
    if (selected !== previous) {
        const socketAvailable = yield* exists(options.socketUnitFile);
        const back = yield* integration(() => options.run(join(previous, "runtime", "node", "bin", "node"), [join(previous, "platform", "dist", "cli.js"), "install", "--from-release", previous, "--allow-downgrade", "--installed-by", "script", ...scope.named ? ["--instance", instance] : [], ...socketAvailable ? ["--live"] : []]));
        log.push(...tail(back.output));
    }
    // Only restart what is not already answering: a swap that failed before it began changed nothing.
    let restored = yield* integration(() => options.healthy(receipt.port));
    if (!restored) {
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
const exists = Effect.fn("PlatformUpdate.exists")(function* (path: string): Effect.fn.Return<boolean, TaggedFailure> {
    return yield* Effect.catch(Effect.map(integration(() => access(path)), () => true), Effect.fn("PlatformUpdate.recover")(function* () { return false; }));
});
const swapUser = Effect.fn("PlatformUpdate.swapUser")(function* (options: UpdateRunnerOptions, context: {
    directory: string;
    run: ZelavisUpdateRun;
    finish: (state: ZelavisUpdateRun["state"], message: string, extra?: Partial<ZelavisUpdateRun>) => Effect.Effect<ZelavisUpdateRun, TaggedFailure>;
    log: string[];
    newRelease: string;
    previous: string;
    target: string;
    from: string;
}): Effect.fn.Return<ZelavisUpdateRun, TaggedFailure> {
    const { finish, log, newRelease, previous, target, from } = context;
    const instance = options.instance ?? "default";
    yield* writeStatus(context.directory, { ...context.run, message: `Selecting ${target}.` });
    const install = (release: string, extra: readonly string[]) => integration(() => options.run(join(release, "runtime", "node", "bin", "node"), [join(release, "platform", "dist", "cli.js"), "install", "--from-release", release, "--user", "--live", "--installed-by", "script", ...extra]));
    const swapped = yield* install(newRelease, []);
    log.push(...tail(swapped.output));
    if (swapped.code === 0) {
        yield* Effect.catch(pruneReleases(options.prefix, instance, previous, options.keepRelease), Effect.fn("PlatformUpdate.recover")(function* () { return undefined; }));
        return yield* finish("succeeded", `Updated to ${target}. Restart Zelavis to start using it; ${from} keeps running until then.`, { log: log.slice(-LOG_LINES) });
    }
    // The installer failed part-way; put the release that was selected back so the next start is the known one.
    if ((yield* Effect.orElseSucceed(release(options.prefix, instance), () => previous)) !== previous)
        yield* Effect.map(install(previous, ["--allow-downgrade"]), (back) => log.push(...tail(back.output)));
    return yield* finish("rolled-back", `The installer stopped with an error (exit ${swapped.code}); ${from} is still selected and still running.`, { log: log.slice(-LOG_LINES) });
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
