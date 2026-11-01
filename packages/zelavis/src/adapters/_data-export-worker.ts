/**
 * Exports every Tenant of a database with the engine that wrote it.
 *
 * The data-layout migration never reads another engine's storage itself: it runs this file under the OLD engine's own Node,
 * which imports that engine's `zelavis/db` and uses its backup export, then writes one JSON file per Tenant for the current
 * engine to recreate. The earlier engine's own Effect runtime runs its programs; this file's runtime only sequences them.
 *
 *   node _data-export-worker.js --platform <old release>/platform --shards <copy of its shards> --out <empty directory>
 *
 * Exit 0 writes `manifest.json` last; any other exit leaves no manifest. It refuses (exit 3) a Tenant whose export reaches the
 * released engine's silent cap of one million events, because such an export may be truncated.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { evaluate, integration } from "../core/runtime/effect-boundary.js";

const EXPORT_EVENT_CAP = 1_000_000;

interface EarlierEngine {
  readonly database: {
    readonly tenants: unknown;
    readonly forTenant: (tenant: string) => { readonly backups: { readonly exportTenant: unknown } };
  };
  readonly close: () => Promise<void>;
}

const option = (name: string) => evaluate(() => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`Missing --${name}.`);
  return value;
});

const program = Effect.gen(function* () {
  const platform = yield* option("platform"), shards = yield* option("shards"), out = yield* option("out");
  const earlier = yield* integration(() => import(pathToFileURL(join(platform, "dist", "db", "node-host.js")).href) as Promise<{ openNodeDatabase: (options: { directory: string }) => Promise<EarlierEngine> }>);
  const earlierEffect = yield* integration(() => import(pathToFileURL(join(platform, "node_modules", "effect", "dist", "index.js")).href) as Promise<{ Effect: { runPromise: (program: unknown) => Promise<unknown> } }>);
  const run = <A>(earlierProgram: unknown) => integration(() => earlierEffect.Effect.runPromise(earlierProgram) as Promise<A>);
  const opened = yield* integration(() => earlier.openNodeDatabase({ directory: shards }));
  const exported = Effect.gen(function* () {
    yield* integration(() => mkdir(out, { recursive: true }));
    const tenants = yield* run<string[]>(opened.database.tenants);
    const files: Array<{ tenant: string; file: string; events: number }> = [];
    for (const [index, tenant] of tenants.entries()) {
      const backup = yield* run<{ events: unknown[] }>(opened.database.forTenant(tenant).backups.exportTenant);
      if (backup.events.length >= EXPORT_EVENT_CAP) {
        return yield* evaluate(() => { throw new Error(`REFUSED Tenant "${tenant}" exported ${backup.events.length} events, which reaches the released engine's export cap; its export may be truncated.`); });
      }
      const file = `tenant-${index}.json`;
      yield* integration(() => writeFile(join(out, file), JSON.stringify({ tenant, events: backup.events })));
      files.push({ tenant, file, events: backup.events.length });
    }
    yield* integration(() => writeFile(join(out, "manifest.json"), JSON.stringify({ format: "zelavis-data-export/1", tenants: files })));
  });
  yield* exported.pipe(Effect.ensuring(integration(() => opened.close()).pipe(Effect.orDie)));
});

Effect.runFork(program.pipe(
  Effect.catch((error) => Effect.sync(() => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.message.startsWith("REFUSED") ? 3 : 1;
  })),
));
