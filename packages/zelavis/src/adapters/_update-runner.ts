import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
  /** How long a new release gets to answer before it is rolled back. */
  healthTimeoutMs?: number;
}

interface Receipt {
  readonly version: string;
  readonly port: number;
  readonly mode: string;
  readonly instance: string;
}

async function readReceipt(prefix: string): Promise<Receipt> {
  const value = JSON.parse(await readFile(join(prefix, "installation.json"), "utf8")) as Partial<Receipt>;
  if (value.mode !== "system" || value.instance !== "default" || !isExactVersion(value.version) || !Number.isInteger(value.port)) {
    throw new Error("Only the default system installation can update itself.");
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

async function release(prefix: string): Promise<string> {
  return realpath(join(prefix, "current"));
}

/** Keeps the selected release, the one just replaced (for rollback) and anything an instance selects. */
async function pruneReleases(prefix: string, previous: string): Promise<void> {
  const keep = new Set<string>([await release(prefix), previous]);
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

  const receipt = await readReceipt(options.prefix);
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

  const previous = await release(options.prefix);
  const script = join(previous, "platform", "dist", "installation-assets", "install.sh");
  run = { ...run, to: target, message: `Installing ${target}.` };
  await writeStatus(directory, run);

  // The installer shipped inside the installed release does the whole job: it
  // fetches the pinned Node and the exact package, installs it beside the
  // current release, switches over and restarts the service.
  const installed = await options.run("sh", [script, "--version", target]);
  const log = tail(installed.output);
  let failure: string | undefined = installed.code === 0 ? undefined : `The installer stopped with an error (exit ${installed.code}).`;

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
    await pruneReleases(options.prefix, previous).catch(() => undefined);
    return finish("succeeded", `Updated from ${receipt.version} to ${target}.`, { log });
  }

  // Put the previous release back. It is kept on disk and complete, so the same
  // installer can select it again from where it lies.
  run = { ...run, message: `${failure} Going back to ${receipt.version}.`, log };
  await writeStatus(directory, run);
  const selected = await release(options.prefix).catch(() => previous);
  if (selected !== previous) {
    const node = join(previous, "runtime", "node", "bin", "node");
    const back = await options.run(node, [join(previous, "platform", "dist", "cli.js"), "install", "--from-release", previous, "--allow-downgrade", "--installed-by", "script"]);
    log.push(...tail(back.output));
  }
  await options.run("systemctl", ["restart", "zelavis"]);
  let restored = false;
  for (let attempt = 0; attempt < 20 && !restored; attempt += 1) {
    restored = await options.healthy(receipt.port);
    if (!restored) await options.sleep(2000);
  }
  return finish("rolled-back", restored
    ? `${failure} Rolled back to ${receipt.version}, which is running again.`
    : `${failure} Rolling back to ${receipt.version} did not bring it back; check the server with: journalctl -u zelavis`,
  { log: log.slice(-LOG_LINES) });
}

