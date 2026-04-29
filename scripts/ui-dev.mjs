import { execSync, spawn } from "node:child_process";
import getPort, { portNumbers } from "get-port";

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

function parsePreferredPort(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

async function main() {
  const preferredBackendPort = parsePreferredPort(process.env.PORT, 3000);
  const preferredUiPort = parsePreferredPort(process.env.ZELAVIS_UI_PORT, 3001);
  const searchWindow = 50;

  console.log("Preparing Zelavis runtime packages for dashboard dev...");
  runSetup(
    "pnpm --filter @zelavis/server build && pnpm --filter @zelavis/database build && pnpm --filter @zelavis/auth build && pnpm --filter zelavis build:runtime",
  );

  const backendPort = await getPort({
    port: portNumbers(
      preferredBackendPort,
      preferredBackendPort + searchWindow,
    ),
  });
  const uiPort = await getPort({
    port: portNumbers(preferredUiPort, preferredUiPort + searchWindow),
    exclude: [backendPort],
  });
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;

  console.log(`Starting Zelavis runtime on ${backendOrigin} ...`);
  console.log(`Starting UI dev server on ${uiOrigin} ...`);
  console.log(
    `Dashboard requests to ${backendOrigin}/zelavis will redirect to ${uiOrigin}.`,
  );

  if (backendPort !== preferredBackendPort) {
    console.log(
      `Preferred backend port ${preferredBackendPort} was busy, using ${backendPort}.`,
    );
  }

  if (uiPort !== preferredUiPort) {
    console.log(
      `Preferred UI port ${preferredUiPort} was busy, using ${uiPort}.`,
    );
  }

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
        String(uiPort),
      ],
      {
        ZELAVIS_DEV_SERVER: backendOrigin,
      },
    ),
    startProcess("pnpm", ["--filter", "@zelavis/example-nodejs", "dev"], {
      PORT: String(backendPort),
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
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
