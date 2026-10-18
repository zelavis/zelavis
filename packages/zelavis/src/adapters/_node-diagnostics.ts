import { spawn } from "node:child_process";
import { userInfo } from "node:os";
import { Data, Effect } from "effect";
import { present } from "../core/runtime/effect-boundary.js";
import { readProcessListing, type ZelavisDiagnosticsControl } from "../diagnostics.js";

/** Why the process listing could not be read; its message is safe to show the caller. */
class DiagnosticsFailure extends Data.TaggedError("DiagnosticsFailure")<{ readonly message: string }> {}

const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 5_000;

/** `ps` for the Platform account's own processes, with fixed arguments and no shell. */
const listing = (uid: number) =>
  Effect.callback<string, DiagnosticsFailure>((resume) => {
    const child = spawn("ps", ["-U", String(uid), "-o", "pid=,ppid=,user=,lstart=,etime=,args="], { stdio: ["ignore", "pipe", "ignore"], shell: false, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" } });
    let output = "";
    let bytes = 0;
    let settled = false;
    const finish = (effect: Effect.Effect<string, DiagnosticsFailure>) => { if (!settled) { settled = true; clearTimeout(timer); resume(effect); } };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(Effect.fail(new DiagnosticsFailure({ message: "Listing processes timed out." }))); }, TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_LISTING_BYTES) { child.kill("SIGKILL"); finish(Effect.fail(new DiagnosticsFailure({ message: "The process listing exceeded its bound." }))); return; }
      output += chunk.toString("utf8");
    });
    child.once("error", () => finish(Effect.fail(new DiagnosticsFailure({ message: "Processes cannot be listed on this host." }))));
    child.once("close", (code) => finish(code === 0 ? Effect.succeed(output) : Effect.fail(new DiagnosticsFailure({ message: "Listing processes failed." }))));
    return Effect.sync(() => { if (!settled) { settled = true; clearTimeout(timer); child.kill("SIGKILL"); } });
  });

export function createNodeDiagnosticsControl(options: { readonly dataDirectory: string }): ZelavisDiagnosticsControl {
  return {
    processes: () => present(Effect.gen(function* () {
      const uid = process.getuid?.();
      if (uid === undefined) return yield* Effect.fail(new DiagnosticsFailure({ message: "Processes cannot be listed on this host." }));
      const text = yield* listing(uid);
      return readProcessListing(text, { dataDirectory: options.dataDirectory, user: userInfo().username, now: new Date() });
    })),
  };
}
