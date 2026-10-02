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
  run(command: string, args: readonly string[]): Promise<{ readonly code: number; readonly output: string }>;
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

async function readReceipt(prefix: string, instance: string, mode: "system" | "user"): Promise<Receipt> {
  const scope = installationInstanceScope(prefix, instance);
  const value = JSON.parse(await readFile(scope.receipt, "utf8")) as Partial<Receipt>;
  if (value.mode !== mode || value.instance !== instance || !isExactVersion(value.version) || !Number.isInteger(value.port)) {
    throw new Error(`This is not a ${mode} installation that can update itself.`);
  }
  return value as Receipt;
}

async function writeStatus(directory: string, run: ZelavisUpdateRun): Promise<void> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, UPDATE_STATUS_FILE);
  const temporary = `${file}.${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(run)}\n`, { mode: 0o644, flag: "wx" });
  try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
}

/** The installer prints the first-owner token on a fresh install; none of that belongs in a status file. */
function tail(output: string): string[] {
  return output.split("\n").map((line) => line.trimEnd()).filter(Boolean)
    .map((line) => /token|password|secret/i.test(line) ? "[redacted]" : line)
    .slice(-LOG_LINES);
}

async function release(prefix: string, instance: string): Promise<string> {
  return realpath(installationInstanceScope(prefix, instance).current);
}

/** Keeps the selected release, the one just replaced (for rollback) and anything an instance selects. */
async function pruneReleases(prefix: string, instance: string, previous: string, running?: string): Promise<void> {
  const keep = new Set<string>([previous, ...running ? [await realpath(running).catch(() => running)] : []]);
  for (const name of ["default", instance]) {
    const selected = await release(prefix, name).catch(() => undefined);
    if (selected) keep.add(selected);
  }
  const instances = await readdir(join(prefix, "instances")).catch(() => [] as string[]);
  for (const name of instances) {
    const selected = await realpath(join(prefix, "instances", name, "current")).catch(() => undefined);
    if (selected) keep.add(selected);
  }
  const releases = join(prefix, "releases");
  for (const name of await readdir(releases).catch(() => [] as string[])) {
    const path = join(releases, name);
    if (!keep.has(await realpath(path).catch(() => path))) await rm(path, { recursive: true, force: true });
  }
}

/**
 * Runs the update a request asked for. Host-local and root only: it replaces
 * the installed release, so it is never an HTTP route.
 *
 * It ignores what the request says beyond its existence. The target is the
 * newest version on the channel of the version that is running, from the
 * registry, and anything not newer is refused, so a request can only ever ask
 * for the update the operator could have run by hand.
 */
export async function runUpdate(options: UpdateRunnerOptions): Promise<ZelavisUpdateRun | undefined> {
  const directory = join(options.dataDirectory, "update");
  const requestFile = join(directory, UPDATE_REQUEST_FILE);
  const now = options.now ?? (() => new Date());
  let id: string;
  try {
    const request = JSON.parse(await readFile(requestFile, "utf8")) as { id?: unknown };
    id = typeof request.id === "string" && request.id.length <= 128 ? request.id : randomUUID();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    id = randomUUID();
  }
  // Consumed first, so a failure cannot make systemd run the same request again.
  await rm(requestFile, { force: true });

  const instance = options.instance ?? "default";
  const scope = installationInstanceScope(options.prefix, instance);
  const mode = options.mode ?? "system";
  const receipt = await readReceipt(options.prefix, instance, mode);
  const startedAt = now().toISOString();
  let run: ZelavisUpdateRun = { id, state: "running", from: receipt.version, startedAt, message: "Looking up the newest version." };
  await writeStatus(directory, run);
  const finish = async (state: ZelavisUpdateRun["state"], message: string, extra: Partial<ZelavisUpdateRun> = {}) => {
    run = { ...run, ...extra, state, message, finishedAt: now().toISOString() };
    await writeStatus(directory, run);
    return run;
  };

  const channel = updateChannel(receipt.version);
  if (!channel) return finish("failed", "This build is not on a published update channel.");
  let target: string;
  try {
    target = await options.channelVersion(channel);
  } catch (error) {
    return finish("failed", `The newest version could not be looked up: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (compareVersions(target, receipt.version) <= 0) {
    return finish("succeeded", "Already on the newest version.", { to: receipt.version });
  }

  const previous = await release(options.prefix, instance);
  const script = join(previous, "platform", "dist", "installation-assets", "install.sh");
  run = { ...run, to: target, message: `Preparing ${target} while ${receipt.version} keeps serving.` };
  await writeStatus(directory, run);

  // Phase 1, prepare: the installer shipped inside the installed release fetches the pinned Node
  // and the exact package and lays the new release beside the current one. The running Platform
  // is not touched, so a failure here costs nothing and nobody notices the download.
  const prepared = await options.run("sh", [script, "--version", target, "--stage-only", ...mode === "user" ? ["--user"] : []]);
  const log = tail(prepared.output);
  if (prepared.code !== 0) {
    return finish("failed", `Could not prepare ${target}, so nothing was changed and ${receipt.version} is still running.`, { log });
  }

  // Phase 2, swap: the new release's own installer selects it and restarts once. With the
  // socket held by systemd that restart queues connections instead of refusing them; before
  // the socket exists (the first update after it was introduced) the full installer is used.
  const newRelease = join(options.prefix, "releases", target);
  if (mode === "user") return swapUser(options, { directory, run, finish, log, newRelease, previous, target, from: receipt.version });
  const live = await exists(options.socketUnitFile);
  run = { ...run, message: live ? `Switching to ${target}.` : `Installing ${target}; this update restarts the service for a few seconds.` };
  await writeStatus(directory, run);
  const node = join(newRelease, "runtime", "node", "bin", "node");
  const swapped = await options.run(node, [join(newRelease, "platform", "dist", "cli.js"), "install", "--from-release", newRelease, "--installed-by", "script", ...scope.named ? ["--instance", instance] : [], ...live ? ["--live"] : []]);
  log.push(...tail(swapped.output));
  let failure: string | undefined = swapped.code === 0 ? undefined : `The installer stopped with an error (exit ${swapped.code}).`;

  if (!failure) {
    const deadline = Date.now() + (options.healthTimeoutMs ?? 90_000);
    let healthy = false;
    while (Date.now() < deadline) {
      if (await options.healthy(receipt.port)) { healthy = true; break; }
      await options.sleep(2000);
    }
    if (!healthy) failure = `Version ${target} did not answer within ${Math.round((options.healthTimeoutMs ?? 90_000) / 1000)} seconds.`;
  }

  if (!failure) {
    await pruneReleases(options.prefix, instance, previous, options.keepRelease).catch(() => undefined);
    return finish("succeeded", `Updated from ${receipt.version} to ${target}.`, { log: log.slice(-LOG_LINES) });
  }

  // Put the previous release back. It is kept on disk and complete, so its own installer can
  // select it again from where it lies.
  run = { ...run, message: `${failure} Going back to ${receipt.version}.`, log: log.slice(-LOG_LINES) };
  await writeStatus(directory, run);
  const selected = await release(options.prefix, instance).catch(() => previous);
  if (selected !== previous) {
    const back = await options.run(join(previous, "runtime", "node", "bin", "node"), [join(previous, "platform", "dist", "cli.js"), "install", "--from-release", previous, "--allow-downgrade", "--installed-by", "script", ...scope.named ? ["--instance", instance] : [], ...await exists(options.socketUnitFile) ? ["--live"] : []]);
    log.push(...tail(back.output));
  }
  // Only restart what is not already answering: a swap that failed before it began changed nothing.
  let restored = await options.healthy(receipt.port);
  if (!restored) {
    await options.run("systemctl", ["restart", scope.units[0]]);
    for (let attempt = 0; attempt < 20 && !restored; attempt += 1) {
      restored = await options.healthy(receipt.port);
      if (!restored) await options.sleep(2000);
    }
  }
  // The release that did not work is no use to anyone; keep it only when the rollback itself failed.
  if (restored) await pruneReleases(options.prefix, instance, previous, options.keepRelease).catch(() => undefined);
  return finish("rolled-back", restored
    ? `${failure} Rolled back to ${receipt.version}, which is running again.`
    : `${failure} Rolling back to ${receipt.version} did not bring it back; check the server with: journalctl -u ${scope.units[0]}`,
  { log: log.slice(-LOG_LINES) });
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/**
 * The user-mode swap. Nothing supervises the Platform, so this selects the new release beside the one in use
 * and says so: the running Platform keeps serving, untouched, until the operator restarts it.
 */
async function swapUser(
  options: UpdateRunnerOptions,
  context: { directory: string; run: ZelavisUpdateRun; finish: (state: ZelavisUpdateRun["state"], message: string, extra?: Partial<ZelavisUpdateRun>) => Promise<ZelavisUpdateRun>; log: string[]; newRelease: string; previous: string; target: string; from: string },
): Promise<ZelavisUpdateRun> {
  const { finish, log, newRelease, previous, target, from } = context;
  const instance = options.instance ?? "default";
  await writeStatus(context.directory, { ...context.run, message: `Selecting ${target}.` });
  const install = (release: string, extra: readonly string[]) => options.run(join(release, "runtime", "node", "bin", "node"), [join(release, "platform", "dist", "cli.js"), "install", "--from-release", release, "--user", "--live", "--installed-by", "script", ...extra]);
  const swapped = await install(newRelease, []);
  log.push(...tail(swapped.output));
  if (swapped.code === 0) {
    await pruneReleases(options.prefix, instance, previous, options.keepRelease).catch(() => undefined);
    return finish("succeeded", `Updated to ${target}. Restart Zelavis to start using it; ${from} keeps running until then.`, { log: log.slice(-LOG_LINES) });
  }
  // The installer failed part-way; put the release that was selected back so the next start is the known one.
  if (await release(options.prefix, instance).catch(() => previous) !== previous) await install(previous, ["--allow-downgrade"]).then((back) => log.push(...tail(back.output)));
  return finish("rolled-back", `The installer stopped with an error (exit ${swapped.code}); ${from} is still selected and still running.`, { log: log.slice(-LOG_LINES) });
}
