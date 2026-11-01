// A Platform that upgrades a running managed Project and is killed from outside at the commit.
// Argument: JSON { base, hang: "before" | "after" }. It prints HANGING when the registry commit is reached.
import { join } from "node:path";

import { createLocalProjectRuntime } from "../../dist/adapters/_local-project-runtime.js";
import { createLocalAgentProcessRunner } from "../../dist/adapters/_agent-process-runner.js";
import { createLocalSqliteSystemStore } from "../../dist/adapters/_sqlite-system-store.js";
import { createProjectManager } from "../../dist/project.js";
import { entry, sourcesIn } from "./managed-live.mjs";

const { base, hang } = JSON.parse(process.argv[2]);
const projects = join(base, "projects");
const sources = await sourcesIn(base);
const sqlite = createLocalSqliteSystemStore({ filename: join(base, "registry.sqlite") });
const store = new Proxy(sqlite, { get(target, key) {
  const value = Reflect.get(target, key);
  if (typeof value !== "function") return value;
  return (...args) => {
    const record = args.find((argument) => argument && typeof argument === "object" && "recipe" in argument);
    const committing = record?.recipe?.version === "2.0.0" && record.runtimeUpdate && !record.runtimeUpdate.error;
    if (!committing) return value.apply(target, args);
    // The commit: dies before it is durable, or right after it is and before anyone is told.
    if (hang === "before") { console.log("HANGING"); return new Promise(() => {}); }
    return Promise.resolve(value.apply(target, args)).then(() => { console.log("HANGING"); return new Promise(() => {}); });
  };
} });
const agent = createLocalAgentProcessRunner({ stateDirectory: join(projects, ".agent-processes") });
const runtime = createLocalProjectRuntime({ directory: projects, agent,
  recipeRuntimes: { trusted: () => true, packageDirectory: (name, version) => name === "@acme/live" ? sources[version ?? "1.0.0"] : undefined } });
const manager = await createProjectManager({ store, projectRecipes: [entry("2.0.0")], runtime, autoReconcile: false,
  installHost: async () => ({ drivers: ["js"], requirements: ["node"] }) });
await manager.start("live");
console.log("RUNNING");
await manager.upgrade("live", {});
console.log("UPGRADED");
