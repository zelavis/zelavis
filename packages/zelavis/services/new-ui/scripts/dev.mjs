import "./link-local.mjs";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { packageRoot, workspaceRoot } from "./link-local.mjs";
const args = process.argv.slice(2);
const allowed = new Set(["--frontend", "--port", "--ui-port", "--runtime-url", "--embedded", "--data-dir"]);
const options = {};
for (let i = 0; i < args.length; i++) {
  const [name, inline] = args[i].split("=", 2);
  if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
  options[name] = name === "--embedded" ? true : inline ?? args[++i];
}
const frontend = options["--frontend"] ?? "fuzor";
if (!["react", "fuzor"].includes(frontend)) throw new Error("--frontend must be fuzor or react.");
if (options["--embedded"] && options["--runtime-url"]) throw new Error("--embedded cannot be combined with --runtime-url.");
function port(value, fallback) { const result = Number(value ?? fallback); if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`Invalid port: ${value}`); return result; }
function available(preferred, attempts = 0) {
  if (attempts >= 50 || preferred > 65535) throw new Error("No available local port in the next 50 ports.");
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", error => error.code === "EADDRINUSE" ? resolvePort(available(preferred + 1, attempts + 1)) : reject(error));
    server.listen(preferred, "127.0.0.1", () => server.close(() => resolvePort(preferred)));
  });
}
const backendPort = await available(port(options["--port"], 3200));
const uiPort = await available(port(options["--ui-port"], backendPort + 1));
if (backendPort === uiPort) throw new Error("Runtime and UI ports must differ.");
const runtimeUrl = options["--runtime-url"] ?? `http://127.0.0.1:${backendPort}`;
const uiUrl = `http://127.0.0.1:${uiPort}/zelavis`;
const children = [];
let closing = false;
function stop(signal = "SIGTERM") { if (closing) return; closing = true; for (const child of children) child.kill(signal); }
function start(command, argv, cwd, env) {
  const child = spawn(command, argv, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
  children.push(child);
  child.once("error", error => { console.error(error.message); process.exitCode = 1; stop(); });
  child.once("exit", code => { if (!closing) { process.exitCode = code ?? 1; stop(); } });
}
const env = { PORT: String(backendPort), ZELAVIS_TEST_FRONTEND: frontend, ZELAVIS_DEV_SERVER: runtimeUrl, ZELAVIS_UI_BASE_PATH: "/zelavis/", ZELAVIS_UI_DEV_SERVER: options["--embedded"] ? "" : uiUrl, ZELAVIS_DATA_DIR: resolve(options["--data-dir"] ?? resolve(packageRoot, ".zelavis")), ZELAVIS_BOOTSTRAP_TOKEN: process.env.ZELAVIS_BOOTSTRAP_TOKEN ?? randomBytes(32).toString("base64url"), ZELAVIS_GITHUB_MAINTENANCE: "0" };
if (!options["--runtime-url"]) start(process.execPath, ["scripts/runtime.ts"], packageRoot, env);
if (!options["--embedded"]) {
  if (frontend === "fuzor") start(process.execPath, ["node_modules/fuzor/dist/cli.js", "dev", "--target", "spa", "--host", "127.0.0.1", "--port", String(uiPort)], packageRoot, env);
  else {
    const reactRoot = resolve(workspaceRoot, "packages/zelavis/services/zelavis-ui");
    start(process.execPath, [resolve(reactRoot, "node_modules/vite/bin/vite.js"), "dev", "--host", "127.0.0.1", "--port", String(uiPort)], reactRoot, env);
  }
}
console.log(`Frontend: ${frontend}\nDashboard: ${options["--embedded"] ? `${runtimeUrl}/zelavis/` : `${uiUrl}/`}`);
if (!options["--runtime-url"]) console.log(`Isolated data: ${env.ZELAVIS_DATA_DIR}\nFirst-owner bootstrap token: ${env.ZELAVIS_BOOTSTRAP_TOKEN}`);
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop());
