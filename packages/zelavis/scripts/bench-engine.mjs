import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFINITIONS = [
  ["node-sqlite", new URL("../dist/db/engines/node-sqlite.js", import.meta.url).href, "makeNodeSqliteStore", (partition, dir) => [partition, dir]],
  ["libsql", new URL("../dist/db/engines/libsql.js", import.meta.url).href, "makeLibsqlStore", (partition, dir) => [partition, { directory: dir }]],
  ["rocksdb-js", new URL("../dist/db/engines/rocksdb-js.js", import.meta.url).href, "makeRocksdbJsStore", (partition, dir) => [partition, dir]],
  ["rocksdb", new URL("../dist/db/engines/rocksdb.js", import.meta.url).href, "makeRocksdbStore", (partition, dir) => [partition, dir]],
  ["lmdb", new URL("../dist/db/engines/lmdb.js", import.meta.url).href, "makeLmdbStore", (partition, dir) => [partition, dir]],
];

const selected = new Set((process.env.ENGINES ?? "").split(",").map((name) => name.trim()).filter(Boolean));

const unavailable = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  return /optional|not installed|cannot find (?:package|module)|module_not_found|dlopen|native/i.test(message);
};

export const runEngines = async (prefix, body, { collectJson = false } = {}) => {
  const definitions = DEFINITIONS.filter(([name]) => selected.size === 0 || selected.has(name));
  for (const name of selected) {
    if (!DEFINITIONS.some(([candidate]) => candidate === name)) {
      console.error(`[engine unavailable] ${name}: unknown engine (available: ${DEFINITIONS.map(([candidate]) => candidate).join(", ")})`);
    }
  }
  if (!process.env.ZELAVIS_BENCH_ENGINE_CHILD) {
    let failed = false;
    const outputs = [];
    for (const [name] of definitions) {
      const child = await new Promise((resolve) => {
        const childProcess = spawn(globalThis.process.execPath, [globalThis.process.argv[1], ...globalThis.process.argv.slice(2)], {
          env: { ...globalThis.process.env, ENGINES: name, ZELAVIS_BENCH_ENGINE_CHILD: "1" },
          stdio: collectJson ? ["ignore", "pipe", "inherit"] : "inherit",
        });
        let stdout = "";
        if (collectJson) childProcess.stdout.on("data", (chunk) => { stdout += chunk; });
        childProcess.once("error", () => resolve(false));
        childProcess.once("exit", (code, signal) => {
          if (code === 0 && !signal && collectJson && stdout.trim()) outputs.push(stdout);
          resolve(code === 0 && !signal);
        });
      });
      if (!child) failed = true;
    }
    if (failed) process.exitCode = 1;
    return outputs;
  }
  for (const [name, path, factory, args] of definitions) {
    const dir = mkdtempSync(join(tmpdir(), `${prefix}-${name}-`));
    try {
      const module = await import(path);
      await body({ name, dir, open: (partition = "bench") => module[factory](...args(partition, dir)) });
    } catch (error) {
      if (!unavailable(error)) throw error;
      console.error(`[engine unavailable] ${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
};
