import { execSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import getPort, { portNumbers } from "get-port";

const shell = process.platform === "win32";

function runSetup(command) {
  execSync(command, {
    stdio: "inherit",
    env: process.env,
  });
}

function startProcess(name, command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell,
    env: {
      ...process.env,
      ...env,
    },
  });

  child.__zelavisName = name;
  return child;
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

function listListeningPids(port) {
  try {
    const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    })
      .toString()
      .trim();

    return output
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function probeUrl(url) {
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/json",
      },
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text =
      response.status >= 500 || contentType.includes("application/json")
        ? await response.text()
        : "";

    return {
      ok: response.ok,
      status: response.status,
      contentType,
      text,
      location: response.headers.get("location"),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      contentType: "",
      text: error instanceof Error ? error.message : String(error),
      location: null,
    };
  }
}

async function recycleUnhealthyPreferredPort(input) {
  const pids = listListeningPids(input.port);
  if (pids.length === 0) {
    return false;
  }

  const probe = await probeUrl(input.url);
  const healthy =
    input.kind === "ui"
      ? probe.status === 200 && probe.contentType.includes("text/html")
      : probe.status === 307 &&
        typeof probe.location === "string" &&
        probe.location.includes("/zelavis");

  if (healthy) {
    return false;
  }

  console.warn(
    `Detected an unhealthy ${input.kind} dev server on port ${input.port}; reclaiming the preferred port.`,
  );
  if (probe.status || probe.text) {
    console.warn(
      `Probe ${input.url} -> ${probe.status || "unreachable"}${probe.text ? ` (${probe.text.slice(0, 160)})` : ""}`,
    );
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore stale PID races.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 400));
  return true;
}

async function main() {
  const preferredBackendPort = parsePreferredPort(process.env.PORT, 3000);
  const preferredUiPort = parsePreferredPort(process.env.ZELAVIS_UI_PORT, 3001);
  const searchWindow = 50;
  const uiBasePath = "/zelavis/";

  console.log("Preparing Zelavis runtime packages for dashboard dev...");
  runSetup(
    "pnpm --filter @zelavis/server build && pnpm --filter @zelavis/db build && pnpm --filter @zelavis/db-node-sqlite build && pnpm --filter @zelavis/auth build && pnpm --filter @zelavis/ui build:plugin && pnpm --filter zelavis build:runtime",
  );

  await recycleUnhealthyPreferredPort({
    kind: "backend",
    port: preferredBackendPort,
    url: `http://127.0.0.1:${preferredBackendPort}/zelavis`,
  });
  await recycleUnhealthyPreferredPort({
    kind: "ui",
    port: preferredUiPort,
    url: `http://127.0.0.1:${preferredUiPort}${uiBasePath}`,
  });

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
  const uiDashboardOrigin = new URL(uiBasePath, uiOrigin).toString();
  const uiDashboardRedirectOrigin = uiDashboardOrigin.replace(/\/+$/, "");

  console.log(`Starting Zelavis runtime on ${backendOrigin} ...`);
  console.log(`Starting UI dev server on ${uiDashboardOrigin} ...`);
  console.log(
    `Dashboard requests to ${backendOrigin}/zelavis will redirect to ${uiDashboardOrigin}.`,
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
      "ui-dev-server",
      "pnpm",
      [
        "--filter",
        "@zelavis/ui",
        "exec",
        "vite",
        "dev",
        "--force",
        "--host",
        "127.0.0.1",
        "--port",
        String(uiPort),
      ],
      {
        ZELAVIS_DEV_SERVER: backendOrigin,
        ZELAVIS_UI_BASE_PATH: uiBasePath,
      },
    ),
    startProcess("node-runtime-example", "pnpm", ["--filter", "@zelavis/example-nodejs", "dev"], {
      PORT: String(backendPort),
      ZELAVIS_BLUEPRINTS_DIR: resolve("packages/zelavis/blueprints"),
      ZELAVIS_UI_DEV_SERVER: uiDashboardRedirectOrigin,
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
        const name = child.__zelavisName ?? "child-process";
        if (code !== 0 || signal) {
          console.error(
            `${name} exited before pnpm dev could keep running${code !== null ? ` (code ${code})` : ""}${signal ? ` (signal ${signal})` : ""}.`,
          );
        } else {
          console.error(
            `${name} exited early with code 0. pnpm dev expects both the runtime and UI dev server to stay alive.`,
          );
        }
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
