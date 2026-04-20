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

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      ...options.headers,
    },
  });
  const body = await response.json();
  return { body, response };
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
    const config = await waitForJson(
      `http://localhost:${port}/zelavis/api/v1/dashboard/config`,
      output,
    );

    assert.equal(databaseHealth.status, "ok");
    assert.equal(databaseHealth.driver, "in-memory");
    assert.equal(databaseHealth.defaultTenantId, "default");
    assert.deepEqual(authMethods, []);
    assert.equal(dashboard.status, 200);
    assert.match(dashboardHtml, /Zelavis Dashboard/);
    assert.ok(assetPath);
    assert.equal(dashboardAsset?.status, 200);
    assert.equal(settings.status, 200);
    assert.equal(config.rootPath, "/zelavis");

    const collection = await requestJson(
      `http://localhost:${port}/zelavis/api/v1/database/documents/collections`,
      {
        method: "POST",
        body: JSON.stringify({ name: "products" }),
      },
    );
    const duplicateCollection = await requestJson(
      `http://localhost:${port}/zelavis/api/v1/database/documents/collections`,
      {
        method: "POST",
        body: JSON.stringify({ name: "products" }),
      },
    );
    const createdDocument = await requestJson(
      `http://localhost:${port}/zelavis/api/v1/database/documents/products`,
      {
        method: "POST",
        body: JSON.stringify({
          id: "example-product",
          data: {
            name: "Example Product",
            status: "draft",
          },
        }),
      },
    );
    const updatedDocument = await requestJson(
      `http://localhost:${port}/zelavis/api/v1/database/documents/products/example-product`,
      {
        method: "PATCH",
        body: JSON.stringify({
          data: {
            status: "active",
          },
        }),
      },
    );
    const queriedDocuments = await requestJson(
      `http://localhost:${port}/zelavis/api/v1/database/documents/products/query`,
      {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      },
    );
    const deletedDocument = await requestJson(
      `http://localhost:${port}/zelavis/api/v1/database/documents/products/example-product`,
      {
        method: "DELETE",
      },
    );

    assert.equal(collection.response.status, 201);
    assert.equal(collection.body.name, "products");
    assert.equal(duplicateCollection.response.status, 409);
    assert.match(duplicateCollection.body.error, /already exists/);
    assert.equal(createdDocument.response.status, 201);
    assert.equal(createdDocument.body.id, "example-product");
    assert.equal(updatedDocument.response.status, 200);
    assert.equal(updatedDocument.body.data.status, "active");
    assert.equal(queriedDocuments.response.status, 200);
    assert.equal(queriedDocuments.body.documents.length, 1);
    assert.equal(deletedDocument.response.status, 200);
    assert.equal(deletedDocument.body.deleted, true);
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
    const config = await waitForJson(
      `http://localhost:${port}/zelavis/api/v1/dashboard/config`,
      output,
    );

    assert.deepEqual(appHealth, { ok: true });
    assert.equal(databaseHealth.status, "ok");
    assert.equal(databaseHealth.driver, "in-memory");
    assert.equal(databaseHealth.defaultTenantId, "default");
    assert.equal(dashboard.status, 200);
    assert.match(dashboardHtml, /Zelavis Dashboard/);
    assert.ok(assetPath);
    assert.equal(dashboardAsset?.status, 200);
    assert.equal(settings.status, 200);
    assert.equal(config.rootPath, "/zelavis");
  } finally {
    await stopExample(child);
  }
});
