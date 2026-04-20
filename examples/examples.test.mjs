import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

const startupTimeoutMs = 10_000;

function startExample(script, port) {
  const child = spawn("node", ["--experimental-strip-types", script], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];

  child.stdout.on("data", (chunk) => {
    output.push(chunk.toString());
  });
  child.stderr.on("data", (chunk) => {
    output.push(chunk.toString());
  });

  return { child, output };
}

async function stopExample(child) {
  if (child.exitCode !== null) {
    return;
  }

  child.kill();
  await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function waitForJson(url, output) {
  const startedAt = Date.now();
  let lastError;

  while (Date.now() - startedAt < startupTimeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return response.json();
      }

      lastError = new Error(`Unexpected ${response.status} from ${url}`);
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(
    `Timed out waiting for ${url}: ${lastError instanceof Error ? lastError.message : "unknown"}\n${output.join("")}`,
  );
}

test("examples/nodejs.ts starts a native Node Zelavis server", async () => {
  const port = 3187;
  const { child, output } = startExample("examples/nodejs.ts", port);

  try {
    const databaseHealth = await waitForJson(
      `http://localhost:${port}/zelavis/api/v1/database/health`,
      output,
    );
    const authMethods = await waitForJson(
      `http://localhost:${port}/zelavis/api/v1/auth/providers`,
      output,
    );
    const dashboard = await fetch(`http://localhost:${port}/zelavis`);
    const dashboardHtml = await dashboard.text();
    const assetPath = dashboardHtml.match(/\/zelavis\/assets\/[^"]+\.js/)?.[0];
    const dashboardAsset = assetPath
      ? await fetch(`http://localhost:${port}${assetPath}`)
      : undefined;
    const settings = await fetch(`http://localhost:${port}/zelavis/settings`);

    assert.equal(databaseHealth.status, "ok");
    assert.equal(databaseHealth.driver, "in-memory");
    assert.equal(databaseHealth.defaultTenantId, "default");
    assert.deepEqual(authMethods, []);
    assert.equal(dashboard.status, 200);
    assert.match(dashboardHtml, /Zelavis Dashboard/);
    assert.ok(assetPath);
    assert.equal(dashboardAsset?.status, 200);
    assert.equal(settings.status, 200);
  } finally {
    await stopExample(child);
  }
});

test("examples/express.ts mounts Zelavis into an existing Express app", async () => {
  const port = 3188;
  const { child, output } = startExample("examples/express.ts", port);

  try {
    const appHealth = await waitForJson(`http://localhost:${port}/health`, output);
    const databaseHealth = await waitForJson(
      `http://localhost:${port}/zelavis/api/v1/database/health`,
      output,
    );
    const dashboard = await fetch(`http://localhost:${port}/zelavis`);
    const dashboardHtml = await dashboard.text();
    const assetPath = dashboardHtml.match(/\/zelavis\/assets\/[^"]+\.js/)?.[0];
    const dashboardAsset = assetPath
      ? await fetch(`http://localhost:${port}${assetPath}`)
      : undefined;
    const settings = await fetch(`http://localhost:${port}/zelavis/settings`);

    assert.deepEqual(appHealth, { ok: true });
    assert.equal(databaseHealth.status, "ok");
    assert.equal(databaseHealth.driver, "in-memory");
    assert.equal(databaseHealth.defaultTenantId, "default");
    assert.equal(dashboard.status, 200);
    assert.match(dashboardHtml, /Zelavis Dashboard/);
    assert.ok(assetPath);
    assert.equal(dashboardAsset?.status, 200);
    assert.equal(settings.status, 200);
  } finally {
    await stopExample(child);
  }
});
