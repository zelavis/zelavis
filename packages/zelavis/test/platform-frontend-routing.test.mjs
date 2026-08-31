import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import {
  findRunningFrontend,
  isRuntimeControlPlanePath,
} from "../dist/platform/project-gateway.js";

test("control-plane paths stay with the Zelavis runtime", () => {
  for (const path of ["zelavis", "/zelavis", "zelavis/api/v1/runtime/config"]) {
    assert.equal(
      isRuntimeControlPlanePath(path),
      true,
      `${path} belongs to the runtime`,
    );
  }
});

test("public paths belong to the frontend", () => {
  for (const path of ["", "/", "about", "assets/app.js", "zelavisation"]) {
    assert.equal(
      isRuntimeControlPlanePath(path),
      false,
      `${path} is public surface`,
    );
  }
});

test("only a running frontend is selected", async () => {
  const owned = [
    { id: "other", kind: "zelavis", runtime: { status: "running", url: "http://x" } },
    { id: "fe-starting", kind: "frontend", runtime: { status: "starting" } },
    { id: "fe", kind: "frontend", runtime: { status: "running", url: "http://127.0.0.1:9" } },
  ];
  const projects = { listOwned: async () => owned };

  assert.deepEqual(await findRunningFrontend(projects, "site"), {
    url: "http://127.0.0.1:9",
  });

  // A Project with no frontend keeps its own runtime as the target.
  assert.equal(
    await findRunningFrontend({ listOwned: async () => [] }, "site"),
    undefined,
  );

  // A frontend mid-start must not take the site down.
  assert.equal(
    await findRunningFrontend(
      { listOwned: async () => [owned[1]] },
      "site",
    ),
    undefined,
  );
});

test("a failing ownership lookup does not break the Gateway", async () => {
  const projects = {
    listOwned: async () => {
      throw new Error("store unavailable");
    },
  };
  // The Project's own runtime remains reachable rather than the proxy failing.
  assert.equal(await findRunningFrontend(projects, "site"), undefined);
});

/** A stand-in frontend that reports every header it was sent. */
function startFrontend() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, headers: request.headers }));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

test("a Project's public paths reach its frontend, and never carry Platform authority", async () => {
  const { createProjectGatewayRoutes } = await import(
    "../dist/platform/project-gateway.js"
  );
  const frontend = await startFrontend();
  const runtime = await startFrontend();

  const project = {
    id: "site",
    kind: "zelavis",
    runtime: { status: "running", url: runtime.url },
  };
  const owned = [
    { id: "site-frontend", kind: "frontend", runtime: { status: "running", url: frontend.url } },
  ];

  let signed = 0;
  const routes = createProjectGatewayRoutes({
    projects: {
      get: async () => project,
      listOwned: async () => owned,
      signGatewayAuthority: async () => {
        signed += 1;
        return "signed-envelope";
      },
    },
    fabric: {
      getProjectPlacement: async () => ({
        identity: { type: "project", workloadId: "site", scopeId: "local" },
        state: "active",
        generation: 1,
        runtimeNodeId: "local",
      }),
      getNode: async () => ({ id: "local", status: "ready" }),
    },
    unavailableProjectsResponse: () => ({ status: 503, body: {} }),
    projectErrorResponse: (error) => ({ status: 500, body: { error: String(error) } }),
  });

  const get = routes.find((route) => route.method === "GET");
  const call = (path) =>
    get.handler({
      params: { projectId: "site", path },
      query: new URLSearchParams(),
      request: new Request(`http://localhost/${path}`),
      principal: { id: "owner", type: "user", permissions: ["*"] },
    });

  try {
    const publicResponse = await call("about");
    const publicBody = JSON.parse(new TextDecoder().decode(publicResponse.body));
    assert.equal(publicResponse.status, 200);
    assert.equal(publicBody.path, "/about", "the public path must reach the frontend");
    assert.equal(
      publicBody.headers["x-zelavis-authority"],
      undefined,
      "a frontend is third-party code and must never receive Platform authority",
    );
    assert.equal(signed, 0, "no envelope should even be signed for a frontend");

    const controlResponse = await call("zelavis/api/v1/runtime/config");
    const controlBody = JSON.parse(new TextDecoder().decode(controlResponse.body));
    assert.equal(
      controlBody.path,
      "/zelavis/api/v1/runtime/config",
      "the control plane must stay with the Zelavis runtime",
    );
    assert.equal(
      controlBody.headers["x-zelavis-authority"],
      "signed-envelope",
      "the runtime still receives its authority envelope",
    );
    assert.equal(signed, 1);
  } finally {
    frontend.server.close();
    runtime.server.close();
  }
});
