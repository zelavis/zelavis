// Run under Bun: the runtime-store backup component copies a SQLite file through `bun:sqlite`.
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { sqliteFileComponent } from "../../dist/db/node-backups.js";

const directory = await mkdtemp(join(tmpdir(), "zelavis-bun-backup-"));
const file = join(directory, "zelavis.sqlite");
const source = new Database(file);
source.run("CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT)");
source.run("INSERT INTO records VALUES ('session', 'kept')");
// Still open while it is copied, the way a running Project holds it; the host creates the staging folder.
await mkdir(join(directory, "staged"));
await Effect.runPromise(sqliteFileComponent("runtime", file).stage(join(directory, "staged")));
const copy = new Database(join(directory, "staged", "store.sqlite"), { readonly: true });
console.log(JSON.stringify({ runtime: typeof Bun === "undefined" ? "node" : "bun", rows: copy.query("SELECT key, value FROM records").all() }));
copy.close();
source.close();
