// The recipe, package and registry entry shared by the managed live-upgrade test and its crash child.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRecipeManifest } from "zelavis/recipe";

export const dataPath = (version) => version === "1.0.0" ? "data-one" : "data-two";
export const manifestFor = (version) => ({ ...MANIFEST, directories: [{ name: "data", path: dataPath(version) }] });
export const MANIFEST = {
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/app.tar.gz", sha256: "a".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }, { name: "db", protocol: "tcp" }],
};

const RECIPE = (message, launchTag) => `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
const SERVER = ${JSON.stringify(`
const fs = require("node:fs"), http = require("node:http");
const [name, port, configFile, dataDir] = process.argv.slice(2);
if (name === "db" && dataDir && dataDir !== "-") { fs.mkdirSync(dataDir, { recursive: true }); if (!fs.existsSync(dataDir + "/marker")) fs.writeFileSync(dataDir + "/marker", "the application's data"); }
const read = () => { try { return fs.readFileSync(configFile, "utf8"); } catch { return "none"; } };
let current = read();
process.on("SIGHUP", () => { current = read(); });
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end(JSON.stringify({ name, pid: process.pid, config: current, dir: dataDir ?? null }))).listen(Number(port), "127.0.0.1");
setInterval(() => {}, 1000);
`)};
export default defineRecipe({
  install: () => Effect.gen(function* () {
    const host = yield* RecipeHost;
    yield* host.files.write("web.conf", ${JSON.stringify(message)});
    yield* host.files.write("server.js", SERVER);
  }),
  start: (context) => Effect.succeed({ processes: [
    { name: "db", command: "node", args: [context.directories.root + "/server.js", "db", String(context.ports.db), "-", context.directories.named.data], env: {}, dependsOn: [], readiness: { port: "db", timeoutMs: 4000 } },
    { name: "web", command: "node", args: [context.directories.root + "/server.js", "web", String(context.ports.web), context.directories.root + "/web.conf"${launchTag ? ", " + JSON.stringify(launchTag) : ""}], env: {}, dependsOn: ["db"],
      readiness: { port: "web", timeoutMs: 4000 }, config: [context.directories.root + "/web.conf"], update: { strategy: "reload", signal: "SIGHUP" } },
  ] }),
});
`;

export async function recipePackage(base, version, message, launchTag) {
  const directory = join(base, `package-${version}`);
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@acme/live", version, type: "module", exports: { ".": { import: "./dist/index.js" } },
    zelavis: { kind: "app", namespace: "acmelive", project: { runtimeKinds: ["native"], runtime: "./dist/runtime.js", install: manifestFor(version), managed: { adminTitle: "Live admin " + version, adminPath: "/admin/" } } },
  }));
  await writeFile(join(directory, "dist", "index.js"), `import { zelavis } from "zelavis/sdk";
export function register() {
  zelavis.plugins.ui.menus.create({ title: "Integration ${version}", path: "/integration", surface: "root" });
}`);
  await writeFile(join(directory, "dist", "recipe.mjs"), RECIPE(message, launchTag));
  await writeFile(join(directory, "dist", "runtime.js"), `import { createRecipeProjectRuntime } from "zelavis/adapters/project-runtime";
export function createProjectRuntime(context) {
  return createRecipeProjectRuntime({ name: "recipe-live", description: "live recipe", directory: context.directory,
    packageDirectory: context.packageDirectory, agent: context.agent, recipes: context.recipes });
}
`);
  return directory;
}

export const entry = (version) => ({
  service: { name: "@acme/live", kind: "app", version, api: {}, service: {}, marketplace: { title: "Live" },
    project: { runtimeKinds: ["native"], install: parseRecipeManifest(manifestFor(version)), managed: { adminTitle: "Live admin " + version, adminPath: "/admin/" } } },
  specifier: "@acme/live", status: "available", source: "official", order: 0,
});

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sourcesIn = async (base, { replaceWeb = false } = {}) => ({ "1.0.0": await recipePackage(base, "1.0.0", "from version one"), "2.0.0": await recipePackage(base, "2.0.0", "from version two", replaceWeb ? "launched-by-two" : undefined) });

/** A second, differently shaped managed recipe: one process, one port, no directories. */
export const SOLO_MANIFEST = {
  contract: 1,
  methods: [{ id: "native", driver: "js", entry: "./dist/recipe.mjs", requires: ["node"] }],
  software: [{ version: "1.0", archive: "https://example.com/solo.tar.gz", sha256: "b".repeat(64), maxBytes: 1000 }],
  ports: [{ name: "web", protocol: "http" }],
};
export async function soloPackage(base) {
  const directory = join(base, "package-solo");
  await mkdir(join(directory, "dist"), { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "@acme/solo", version: "1.0.0", type: "module", exports: { ".": { import: "./dist/index.js" } },
    zelavis: { kind: "app", namespace: "acmesolo", project: { runtimeKinds: ["native"], runtime: "./dist/runtime.js", install: SOLO_MANIFEST, managed: { adminTitle: "Solo", adminPath: "/admin/" } } },
  }));
  await writeFile(join(directory, "dist", "index.js"), "export function register() {}");
  await writeFile(join(directory, "dist", "recipe.mjs"), `import { Effect } from "effect";
import { RecipeHost, defineRecipe } from "zelavis/recipe";
const SERVER = ${JSON.stringify(`
const http = require("node:http");
process.on("SIGTERM", () => process.exit(0));
http.createServer((request, response) => response.end(JSON.stringify({ name: "solo", pid: process.pid }))).listen(Number(process.argv[2]), "127.0.0.1");
setInterval(() => {}, 1000);
`)};
export default defineRecipe({
  install: () => Effect.gen(function* () { const host = yield* RecipeHost; yield* host.files.write("server.js", SERVER); }),
  start: (context) => Effect.succeed({ processes: [
    { name: "solo", command: "node", args: [context.directories.root + "/server.js", String(context.ports.web)], env: {}, dependsOn: [], readiness: { port: "web", timeoutMs: 4000 } },
  ] }),
});
`);
  await writeFile(join(directory, "dist", "runtime.js"), `import { createRecipeProjectRuntime } from "zelavis/adapters/project-runtime";
export function createProjectRuntime(context) {
  return createRecipeProjectRuntime({ name: "recipe-solo", description: "solo recipe", directory: context.directory,
    packageDirectory: context.packageDirectory, agent: context.agent, recipes: context.recipes });
}
`);
  return directory;
}
export const soloEntry = () => ({
  service: { name: "@acme/solo", kind: "app", version: "1.0.0", api: {}, service: {}, marketplace: { title: "Solo" },
    project: { runtimeKinds: ["native"], install: parseRecipeManifest(SOLO_MANIFEST), managed: { adminTitle: "Solo", adminPath: "/admin/" } } },
  specifier: "@acme/solo", status: "available", source: "official", order: 0,
});
