import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import {
  forwardPublicRequest,
  guardControlPlaneHost,
  resolveVerifiedBinding,
} from "../dist/platform/public-domain-forwarder.js";
import { zelavis, createInMemoryDomainBindingStore } from "../dist/index.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";

function bindingStore(bindings) {
  return { get: async (host) => bindings[host.toLowerCase()] };
}

const verified = (projectId = "site") => ({
  host: "example.com",
  projectId,
  verificationToken: "t",
  verifiedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

test("only a verified binding is routable", async () => {
  const store = bindingStore({
    "example.com": verified(),
    "pending.com": { ...verified(), host: "pending.com", verifiedAt: undefined },
    "systemwide.com": { ...verified(), host: "systemwide.com", projectId: undefined },
  });

  assert.ok(await resolveVerifiedBinding(store, "example.com"));
  // Anyone can point DNS at a host. Verification is what proves the operator
  // controls it, so forwarding before that would let a stranger claim traffic.
  assert.equal(await resolveVerifiedBinding(store, "pending.com"), undefined);
  // A system-level binding has no Project to forward to.
  assert.equal(await resolveVerifiedBinding(store, "systemwide.com"), undefined);
  assert.equal(await resolveVerifiedBinding(store, "unbound.com"), undefined);
});

test("the port is ignored when matching a host", async () => {
  const store = bindingStore({ "example.com": verified() });
  assert.ok(await resolveVerifiedBinding(store, "example.com:8443"));
  assert.ok(await resolveVerifiedBinding(store, "EXAMPLE.COM"));
});

function startSite() {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.setHeader("set-cookie", "site_session=abc; Path=/");
      response.end(JSON.stringify({ path: request.url, headers: request.headers }));
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function platform(site, overrides = {}) {
  return {
    domainBindings: bindingStore({ "example.com": verified() }),
    projects: () => ({
      get: async () => ({
        id: "site",
        kind: "zelavis",
        runtime: { status: "running", url: site.url },
      }),
      listOwned: async () => [],
      ...overrides,
    }),
  };
}

test("a verified domain reaches the Project, anonymously", async () => {
  const site = await startSite();
  try {
    const response = await forwardPublicRequest(
      platform(site),
      new Request("http://example.com/about?q=1", {
        headers: {
          cookie: "zelavis_session=platform_secret",
          authorization: "Bearer platform_secret",
        },
      }),
    );

    assert.equal(response.status, 200);
    const body = JSON.parse(new TextDecoder().decode(response.body));
    assert.equal(body.path, "/about?q=1");

    // A visitor has no Platform identity, and the target may be third-party
    // frontend code. Neither Platform credentials nor authority may reach it.
    assert.equal(body.headers.cookie, undefined);
    assert.equal(body.headers.authorization, undefined);
    assert.equal(body.headers["x-zelavis-authority"], undefined);
  } finally {
    site.server.close();
  }
});

test("the site keeps its own cookies", async () => {
  const site = await startSite();
  try {
    const response = await forwardPublicRequest(
      platform(site),
      new Request("http://example.com/"),
    );
    // Unlike the Gateway, this response is served from the Project's own
    // domain, so its cookies are its own.
    assert.equal(response.headers.get("set-cookie"), "site_session=abc; Path=/");
  } finally {
    site.server.close();
  }
});

test("the control plane is not published on a bound domain", async () => {
  const site = await startSite();
  try {
    const response = await forwardPublicRequest(
      platform(site),
      new Request("http://example.com/zelavis/api/v1/runtime/projects"),
    );
    assert.equal(
      response.status,
      404,
      "the control plane is reached through the dashboard, where the caller has an identity",
    );
  } finally {
    site.server.close();
  }
});

test("an unbound host falls through to the installation's own root", async () => {
  const site = await startSite();
  try {
    assert.equal(
      await forwardPublicRequest(
        platform(site),
        new Request("http://not-bound.example/"),
      ),
      undefined,
    );
  } finally {
    site.server.close();
  }
});

test("a stopped Project answers instead of hanging", async () => {
  const response = await forwardPublicRequest(
    {
      domainBindings: bindingStore({ "example.com": verified() }),
      projects: () => ({
        get: async () => ({ id: "site", kind: "zelavis", runtime: { status: "stopped" } }),
        listOwned: async () => [],
      }),
    },
    new Request("http://example.com/"),
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers["cache-control"], "no-store");
});

test("a running frontend takes precedence over the Project runtime", async () => {
  const site = await startSite();
  const frontend = await startSite();
  try {
    const response = await forwardPublicRequest(
      {
        domainBindings: bindingStore({ "example.com": verified() }),
        projects: () => ({
          get: async () => ({
            id: "site",
            kind: "zelavis",
            runtime: { status: "running", url: site.url },
          }),
          listOwned: async () => [
            {
              id: "site-frontend",
              kind: "frontend",
              runtime: { status: "running", url: frontend.url },
            },
          ],
        }),
      },
      new Request("http://example.com/"),
    );
    assert.equal(response.status, 200);
  } finally {
    site.server.close();
    frontend.server.close();
  }
});

test("the control plane is not served on a Project's domain", async () => {
  const options = { domainBindings: bindingStore({ "example.com": verified() }) };

  for (const path of ["/zelavis", "/zelavis/api/v1/runtime/projects", "/zelavis/login"]) {
    const refused = await guardControlPlaneHost(
      options,
      new Request(`http://example.com${path}`),
      "/zelavis",
    );
    assert.ok(refused, `${path} must not be served on a bound domain`);
    // 404 rather than 403: on this host the control plane does not exist, and
    // saying otherwise would confirm which Platform serves the domain.
    assert.equal(refused.status, 404);
  }

  // The Platform's own hosts are unaffected.
  assert.equal(
    await guardControlPlaneHost(
      options,
      new Request("http://localhost/zelavis"),
      "/zelavis",
    ),
    undefined,
  );

  // A path that merely starts with the same characters is not the control plane.
  assert.equal(
    await guardControlPlaneHost(
      options,
      new Request("http://example.com/zelavisation"),
      "/zelavis",
    ),
    undefined,
  );
});

test("a composed runtime refuses the dashboard on a bound domain", async () => {
  const bindings = createInMemoryDomainBindingStore();
  await bindings.put({
    ...verified(),
    host: "customer.example",
  });

  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    coreServices: { auth: false, database: false },
    domainBindings: bindings,
  });

  // The dashboard route matches before the public forwarder runs, so this is
  // enforced ahead of dispatch rather than inside the frontend service.
  const onBoundDomain = await runtime.fetch(
    new Request("http://customer.example/zelavis"),
  );
  assert.equal(onBoundDomain.status, 404);

  // The Platform's own root still redirects to its dashboard.
  const onPlatformHost = await runtime.fetch(new Request("http://localhost/"));
  assert.equal(onPlatformHost.status, 307);
  assert.equal(onPlatformHost.headers.get("location"), "/zelavis");

  const dashboard = await runtime.fetch(new Request("http://localhost/zelavis"));
  assert.equal(dashboard.status, 200);
});
