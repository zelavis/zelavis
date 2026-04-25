import { execSync, spawn } from "node:child_process";

const backendPort = process.env.PORT ?? "3000";
const uiPort = process.env.ZELAVIS_UI_PORT ?? "3001";
const backendOrigin = `http://127.0.0.1:${backendPort}`;
const uiOrigin = `http://127.0.0.1:${uiPort}`;
const shell = process.platform === "win32";

function runSetup(command) {
  execSync(command, {
    stdio: "inherit",
    env: process.env,
  });
}

function startProcess(command, args, env) {
  return spawn(command, args, {
    stdio: "inherit",
    shell,
    env: {
      ...process.env,
      ...env,
    },
  });
}

console.log("Preparing Zelavis runtime packages for dashboard dev...");
runSetup(
  "pnpm --filter @zelavis/server build && pnpm --filter @zelavis/database build && pnpm --filter @zelavis/auth build && pnpm --filter zelavis build:runtime",
);

console.log(`Starting Zelavis runtime on ${backendOrigin} ...`);
console.log(`Starting UI dev server on ${uiOrigin} ...`);
console.log(
  `Dashboard requests to ${backendOrigin}/zelavis will redirect to ${uiOrigin}.`,
);

const children = [
  startProcess(
    "pnpm",
    [
      "--filter",
      "@zelavis/ui",
      "exec",
      "vite",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      uiPort,
    ],
    {
      ZELAVIS_DEV_SERVER: backendOrigin,
    },
  ),
  startProcess("pnpm", ["--filter", "@zelavis/example-nodejs", "dev"], {
    PORT: backendPort,
    ZELAVIS_UI_DEV_SERVER: uiOrigin,
  }),
];

let shuttingDown = false;

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      shutdown();
      process.exitCode = code ?? (signal ? 1 : 0);
    }
  });

  child.on("error", (error) => {
    console.error(error);
    process.exitCode = 1;
    shutdown();
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
