import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import routes from "../../zelavis-ui/app/routes.ts";
const records = [];
function collect(entries, parent = "") {
  for (const entry of entries) {
    const path = entry.index ? parent || "/" : `${parent}/${entry.path ?? ""}`.replace(/\/{2,}/g, "/");
    records.push({ path, file: entry.file, index: Boolean(entry.index) });
    collect(entry.children ?? [], path === "/" ? "" : path);
  }
}
collect(routes);
const menuSource = await readFile(new URL("../../zelavis-ui/src/dashboard-service.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("dashboard-service.ts", menuSource, ts.ScriptTarget.Latest, true);
let expression;
for (const statement of parsed.statements) if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (declaration.name.getText(parsed) === "zelavisServerMenu") expression = declaration.initializer.getText(parsed);
if (!expression) throw new Error("The current UI server menu could not be inventoried.");
const compiledMenu = ts.transpileModule(`export default ${expression};`, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const serverMenu = (await import(`data:text/javascript;base64,${Buffer.from(compiledMenu).toString("base64")}`)).default;
const source = `// Generated from the current React route manifest by scripts/audit-routes.mjs.\nexport const workspaceRouteManifest = ${JSON.stringify(routes, null, 2)} as const;\nexport const workspaceRouteCatalog = ${JSON.stringify(records, null, 2)} as const;\nexport const serverNavigationMenu = ${JSON.stringify(serverMenu, null, 2)} as const;\n`;
const target = new URL("../app/workspace-route-manifest.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(target, "utf8") !== source) throw new Error("React route inventory changed. Run node scripts/audit-routes.mjs and qualify the changed routes.");
} else await writeFile(target, source);
console.log(`Inventoried ${records.length} route modules, including index, resource and catch-all routes.`);
