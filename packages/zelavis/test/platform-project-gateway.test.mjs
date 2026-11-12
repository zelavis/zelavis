import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zelavis } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { runProjectsCommand } from "../dist/cli/projects.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
// The Gateway lives in its own module, so its internals are imported directly
// rather than scraped out of the bundled Platform composition.
import {
  gatewayRequestHeaders,
  gatewayResponseHeaders,
  resolveProxyTarget,
} from "../dist/platform/project-gateway.js";

const RUNTIME_URL = "http://127.0.0.1:52706";

// Values a caller can put in the Gateway wildcard path. `new URL(ref, base)`
// performs reference resolution, so several of these previously resolved to a
// different origin and turned the Gateway into a confused deputy.
const HOSTILE_PATHS = [
  "https:/example.com/pwn",
  "https://example.com/pwn",
  "//example.com/pwn",
  "///example.com",
  "http:/evil.example/x",
  "\\\\example.com/pwn",
  "file:///etc/passwd",
  "data:text/html,<script>",
  "javascript:alert(1)",
  "../../etc/passwd",
  "..%2F..%2Fetc",
  "%2e%2e%2f%2e%2e",
  "a/%2e%2e/b",
  "....//",
  "%2F%2Fexample.com",
  "a/%ZZ",
  "a\r\nX-Injected: 1",
  "a\nb",
  "a\u0000b",
  "a\u007fb",
];

test("Gateway proxy targets never leave the Project runtime origin", () => {
  for (const path of HOSTILE_PATHS) {
    const target = resolveProxyTarget(RUNTIME_URL, path);
    if (target === undefined) {
      continue;
    }

    assert.equal(
      target.origin,
      RUNTIME_URL,
      `path ${JSON.stringify(path)} escaped to ${target.href}`,
    );
  }
});

test("Gateway proxy rejects traversal, control characters, and bad encoding", () => {
  for (const path of [
    "../../etc/passwd",
    "..%2F..%2Fetc",
    "a/%2e%2e/b",
    "a/%ZZ",
    "a\r\nX-Injected: 1",
    "a\u0000b",
    "\\\\example.com/pwn",
  ]) {
    assert.equal(
      resolveProxyTarget(RUNTIME_URL, path),
      undefined,
      `path ${JSON.stringify(path)} should be rejected outright`,
    );
  }
});

test("Gateway proxy preserves ordinary child paths", () => {
  assert.equal(
    resolveProxyTarget(RUNTIME_URL, "zelavis/api/v1/runtime/config")?.href,
    `${RUNTIME_URL}/zelavis/api/v1/runtime/config`,
  );
  assert.equal(resolveProxyTarget(RUNTIME_URL, "")?.href, `${RUNTIME_URL}/`);
  assert.equal(
    resolveProxyTarget(RUNTIME_URL, "deep/nested/path")?.href,
    `${RUNTIME_URL}/deep/nested/path`,
  );
  // Percent-encoded characters that are legal inside one segment survive.
  assert.equal(
    resolveProxyTarget(RUNTIME_URL, "files/my%20file.txt")?.href,
    `${RUNTIME_URL}/files/my%20file.txt`,
  );
});

test("Gateway proxy neutralizes scheme-like paths onto the runtime origin", () => {
  const target = resolveProxyTarget(RUNTIME_URL, "https://example.com/pwn");
  assert.ok(target);
  assert.equal(target.origin, RUNTIME_URL);
  // Assert the components rather than a substring: a prefix check would pass
  // for `https://example.com.evil.test`.
  assert.equal(target.protocol, "http:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "52706");
});

test("Platform credentials are never relayed into a Project runtime", () => {
  const outbound = gatewayRequestHeaders(
    new Headers({
      cookie: "zelavis_session=zvs_platform_secret",
      authorization: "Bearer zvs_platform_secret",
      "content-type": "application/json",
      "x-zelavis-authority": "forged-envelope",
      "x-zelavis-project-id": "other-project",
      connection: "keep-alive",
      host: "platform.example",
      "content-length": "42",
      "x-request-id": "keep-me",
    }),
  );

  for (const header of [
    "cookie",
    "authorization",
    "x-zelavis-authority",
    "x-zelavis-project-id",
    "connection",
    "host",
    "content-length",
  ]) {
    assert.equal(
      outbound.get(header),
      null,
      `${header} must not reach the Project runtime`,
    );
  }

  // Ordinary headers still pass through.
  assert.equal(outbound.get("content-type"), "application/json");
  assert.equal(outbound.get("x-request-id"), "keep-me");
});

test("a Project cannot set cookies on the Platform origin", () => {
  const inbound = gatewayResponseHeaders(
    new Headers({
      "set-cookie": "zelavis_session=attacker_controlled; Path=/",
      "content-type": "text/html",
      connection: "close",
      "transfer-encoding": "chunked",
    }),
  );

  assert.equal(inbound.get("set-cookie"), null);
  assert.equal(inbound.get("connection"), null);
  assert.equal(inbound.get("transfer-encoding"), null);
  assert.equal(inbound.get("content-type"), "text/html");
});


test("scoped package asset parameters remain encoded on the Project origin", () => {
  const target = resolveProxyTarget("http://127.0.0.1:3000", "zelavis/api/v1/runtime/service-page-assets/%40acme%2Fsite/dashboard/index.html");
  assert.equal(target?.pathname, "/zelavis/api/v1/runtime/service-page-assets/%40acme%2Fsite/dashboard/index.html");
  for (const name of ["%40acme%2F..", "%40acme%2Fsite%2F..", "%40acme%2Fsite%5Cfile", "%2Fetc%2Fpasswd"]) {
    assert.equal(resolveProxyTarget("http://127.0.0.1:3000", `zelavis/api/v1/runtime/service-page-assets/${name}/dashboard/index.html`), undefined);
  }
});

test("registration settings require exact Project authority before forwarding", async (t) => {
  const { platform } = await import("./_runtime.mjs");
  const p = await platform(t);
  const delegate = {
    id: "settings-delegate",
    type: "user",
    grants: [{ permission: "project.settings.manage", scope: { type: "project", projectId: "one" } }],
  };
  p.as(delegate);
  for (const method of ["GET", "PUT"]) {
    const body = method === "PUT" ? { enabled: true, expectedRevision: 0 } : undefined;
    await assert.rejects(p.send(method, "/runtime/projects/two/auth/registration/settings", body), { status: 403 });
    // This Platform has no Project manager. Exact authority reaches that check.
    await assert.rejects(p.send(method, "/runtime/projects/one/auth/registration/settings", body), { status: 503 });
  }
});

test("account access checks the parent Project scope before invoking a child", async (t) => {
  const { platform } = await import("./_runtime.mjs");
  const p = await platform(t);
  p.as({ id: "delegate", type: "user", grants: [
    { permission: "project.users.manage", scope: { type: "project", projectId: "one" } },
  ] });
  const input = { expectedRevision: 0, role: "user", permissions: [], grants: [] };
  await assert.rejects(p.send("PUT", "/runtime/projects/two/auth/accounts/target/access", input), { status: 403 });
  await assert.rejects(p.send("PUT", "/runtime/projects/one/auth/accounts/target/access", input), { status: 503 });
});

test("the exact Project account access route delegates only held child permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-account-access-"));
  const bootstrapToken = "native-account-access-bootstrap-token";
  const zv = new Zelavis({
    adapter: nodeAdapter({ dataDirectory: root, projects: { previewHost: false } }),
    bootstrap: { token: bootstrapToken },
  });
  t.after(async () => {
    await zv.close();
    await rm(root, { recursive: true, force: true });
  });
  const origin = "http://account-access-platform.test";
  const through = (input, init) => zv.fetch(new Request(input, init));
  const client = (token) => createZelavisClient({
    baseUrl: origin, fetch: through, ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });
  const password = "password for project account access";
  const bootstrapped = await client().auth.bootstrap({
    bootstrapToken, provider: "password", account: { username: "owner" }, credential: { identifier: "owner", password },
  });
  const owner = client(bootstrapped.session.token);
  const project = await owner.projects.create({ id: "access-app", name: "App", recipeName: "@zelavis/app" });
  await owner.projects.create({ id: "second-app", name: "Second", recipeName: "@zelavis/app", start: false });
  await owner.projects.setRegistrationSettings(project.id, { enabled: true, expectedRevision: 0 });
  const app = createZelavisClient({ baseUrl: project.runtime.url });
  const { account, session } = await app.auth.signUpWithPassword({ identifier: "person@example.com", password });
  const asAppUser = (token) => createZelavisClient({
    baseUrl: project.runtime.url, headers: { authorization: `Bearer ${token}` },
  });
  const grant = (permission, projectId = project.id) => ({ permission, scope: { type: "project", projectId } });
  const { token } = await owner.auth.admin.createServiceAccount({
    name: "App delegate", grants: [grant("project.users.manage"), grant("example.access")],
  });
  const delegate = client(token);
  const input = { expectedRevision: 0, role: "user", permissions: [], grants: [grant("example.access")] };
  await assert.rejects(delegate.projects.setAccountAccess("second-app", account.id, input), { status: 403 });
  await assert.rejects(delegate.projects.setAccountAccess(project.id, account.id, { ...input, grants: [grant("example.access", "second-app")] }), { status: 403 });
  await assert.rejects(delegate.projects.setAccountAccess(project.id, account.id, { ...input, grants: [grant("database.write")] }), { status: 403 });
  await assert.rejects(delegate.projects.setAccountAccess(project.id, account.id, { ...input, permissions: ["example.access"] }), { status: 403 });
  assert.equal((await asAppUser(session.token).auth.getSession()).principal.id, account.id);

  const cli = async (target = project.id) => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const lines = [];
    globalThis.fetch = (request, init) => new URL(request instanceof Request ? request.url : String(request)).origin === origin
      ? through(request, init) : originalFetch(request, init);
    console.log = (...parts) => lines.push(parts.join(" "));
    try {
      await runProjectsCommand(["set-account-access", target, account.id, "--data", JSON.stringify(input),
        "--url", `${origin}/zelavis`, "--token", token, "--json"]);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
    return JSON.parse(lines.join("\n"));
  };
  assert.deepEqual(await cli(), { accountId: account.id, accessRevision: 1, role: "user", permissions: [], grants: input.grants });
  await assert.rejects(cli(), { status: 409 });
  await assert.rejects(cli("second-app"), { status: 403 });
  await assert.rejects(asAppUser(session.token).auth.getSession(), { status: 401 });
  await assert.rejects(delegate.projects.setAccountAccess(project.id, account.id, input), { status: 409 });
  const ordinaryProxy = await owner.request(`/runtime/projects/${project.id}/proxy/zelavis/api/v1/auth/accounts/${account.id}/access`, {
    method: "PUT", body: { ...input, expectedRevision: 1, grants: [] },
  });
  assert.equal(ordinaryProxy.status, 403);

  const large = Array.from({ length: 100 }, (_, index) => grant(`example.permission-${String(index).padStart(3, "0")}`));
  const wide = { ...input, expectedRevision: 1, grants: large };
  assert.deepEqual((await owner.projects.setAccountAccess(project.id, account.id, wide)).grants, large);
  const after = await app.auth.signInWithPassword({ identifier: "person@example.com", password });
  assert.deepEqual((await asAppUser(after.session.token).auth.getSession()).principal.grants, large);
  const revoke = { ...input, expectedRevision: 2, grants: [] };
  await assert.rejects(delegate.projects.setAccountAccess(project.id, account.id, revoke), { status: 403 });
  assert.equal((await owner.projects.setAccountAccess(project.id, account.id, revoke)).accessRevision, 3);
  await assert.rejects(asAppUser(after.session.token).auth.getSession(), { status: 401 });
});
