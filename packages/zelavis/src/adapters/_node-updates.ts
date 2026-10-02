import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
}

export function runningVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return manifest.version;
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The registry sent no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RangeError("The registry answered with more than expected.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** The newest version published on a channel, by npm's own dist-tags. */
export async function fetchChannelVersion(channel: "alpha" | "latest", options: { fetch?: typeof fetch; url?: string } = {}): Promise<string> {
  const response = await (options.fetch ?? fetch)(options.url ?? UPDATE_DIST_TAGS_URL, {
    headers: { accept: "application/json" },
    // A redirect is somewhere nobody named.
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`The registry answered ${response.status}.`);
  const tags = await boundedJson(response) as Record<string, unknown>;
  const version = tags?.[channel];
  if (!isExactVersion(version)) throw new Error(`The registry lists no version for the ${channel} channel.`);
  return version;
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
  let checking: Promise<void> | undefined;

  // The installer creates this folder for an installation it set up with the
  // updater, so its absence means this install cannot update itself.
  const unmanaged = (): string | undefined => {
    if ((options.platform ?? process.platform) !== "linux") return "Only server installations set up by the installer can update themselves.";
    if (!channel) return "This build is not on a published update channel.";
    if (!existsSync(directory)) return "This installation was not set up with the updater. Run the installer again to enable it.";
    return undefined;
  };

  async function readState() {
    const [requested, run] = await Promise.all([
      stat(join(directory, UPDATE_REQUEST_FILE)).then(() => true, () => false),
      // Written by another process, so an unreadable file is no information rather than an error.
      readFile(join(directory, UPDATE_STATUS_FILE), "utf8").then((text) => { try { return parseUpdateRun(JSON.parse(text)); } catch { return undefined; } }, () => undefined),
    ]);
    let shown = run;
    if (run?.state === "running" && now() - Date.parse(run.startedAt) > STALE_RUN_MS) {
      shown = { ...run, state: "failed", message: "The update stopped reporting. Check the server's logs with: journalctl -u zelavis-update" };
    }
    return { requested, run: shown };
  }

  async function status(): Promise<ZelavisUpdateStatus> {
    const reason = unmanaged();
    const { requested, run } = await readState();
    const state = requested ? "requested" : run?.state ?? "idle";
    return {
      current,
      ...(channel ? { channel } : {}),
      ...(latest ? { latest } : {}),
      available: latest !== undefined && compareVersions(latest, current) > 0,
      ...(checkedAt !== undefined ? { checkedAt: new Date(checkedAt).toISOString() } : {}),
      ...(checkError ? { checkError } : {}),
      managed: reason === undefined,
      ...(reason ? { unmanagedReason: reason } : {}),
      state,
      ...(run ? { run } : {}),
    };
  }

  async function check(): Promise<ZelavisUpdateStatus> {
    if (channel) {
      // One lookup at a time: a click and the timer must not race the same answer.
      checking ??= (async () => {
        try {
          latest = await fetchChannelVersion(channel, { ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.url ? { url: options.url } : {}) });
          checkError = undefined;
        } catch (error) {
          checkError = error instanceof Error ? error.message : "The check failed.";
        } finally {
          checkedAt = now();
          checking = undefined;
        }
      })();
      await checking;
    }
    return status();
  }

  // Only an installation set up with the updater checks on its own; tests and dev runs make no calls.
  if (options.schedule !== false && channel && existsSync(directory)) {
    void check().catch(() => undefined);
    setInterval(() => void check().catch(() => undefined), CHECK_INTERVAL_MS).unref?.();
  }

  return {
    status,
    check,
    async apply(requestedBy) {
      const reason = unmanaged();
      if (reason) throw new ZelavisUpdateRefusal("unmanaged", reason);
      let state = await status();
      if (state.state === "requested" || state.state === "running") {
        throw new ZelavisUpdateRefusal("busy", "An update is already in progress.");
      }
      if (checkedAt === undefined || now() - checkedAt > FRESH_CHECK_MS) state = await check();
      if (state.latest === undefined) throw new ZelavisUpdateRefusal("unchecked", state.checkError ?? "The newest version could not be looked up.");
      if (!state.available) throw new ZelavisUpdateRefusal("up-to-date", "This installation is already on the newest version.");
      await mkdir(directory, { recursive: true });
      const file = join(directory, UPDATE_REQUEST_FILE);
      const temporary = `${file}.${randomUUID()}`;
      // Only the fact of the request matters to the root updater; it decides the
      // version itself, so nothing here can steer it.
      await writeFile(temporary, `${JSON.stringify({ id: randomUUID(), requestedAt: new Date(now()).toISOString(), requestedBy: requestedBy.slice(0, 200) })}\n`, { mode: 0o600, flag: "wx" });
      try { await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }); throw error; }
      return status();
    },
  };
}
