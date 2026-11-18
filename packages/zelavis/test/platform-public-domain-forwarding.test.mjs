import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  forwardPublicRequest,
  forwardProjectSiteRequest,
  guardControlPlaneHost,
  resolveVerifiedBinding,
} from "../dist/platform/public-domain-forwarder.js";
import { fetchNodeSite } from "../dist/adapters/_node-site-fetch.js";
import { Zelavis, zelavis, createInMemoryDomainBindingStore, defineAdapter } from "../dist/index.js";
import { nodeAdapter } from "../dist/adapters/node.js";
import { createZelavisClient } from "../dist/sdk/fetch.js";
import { zelavisUiFrontend } from "@zelavis/ui/frontend";
import { zelavisUiIdentityFrontend } from "@zelavis/ui/identity-frontend";

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
    fetchSite: fetchNodeSite,
    domainBindings: bindingStore({ "example.com": verified() }),
    projects: () => ({
      view: async () => ({
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
          cookie: "zelavis_access=platform_secret; zelavis_refresh=platform_secret",
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
      fetchSite: fetchNodeSite,
    domainBindings: bindingStore({ "example.com": verified() }),
      projects: () => ({
        view: async () => ({ id: "site", kind: "zelavis", runtime: { status: "stopped" } }),
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
        fetchSite: fetchNodeSite,
    domainBindings: bindingStore({ "example.com": verified() }),
        projects: () => ({
          view: async () => ({
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
    subsystems: { auth: false, database: false },
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

test("a root-mounted dashboard leaves only mounted verification handlers on a bound domain", async () => {
  const options = { domainBindings: bindingStore({ "example.com": verified() }) };
  const get = path => new Request(`http://example.com${path}`);
  assert.equal((await guardControlPlaneHost(options, get("/login"), "/")).status, 404);
  assert.equal(await guardControlPlaneHost(options, get("/.well-known/zelavis-challenge/token"), "/"), undefined);
  assert.equal((await guardControlPlaneHost(options, get("/.well-known/acme-challenge/token"), "/")).status, 404);
  assert.equal(await guardControlPlaneHost({ ...options, acmeChallengeMounted: true }, get("/.well-known/acme-challenge/token"), "/"), undefined);
});

test("host spelling variants of a bound domain never reach the dashboard", async () => {
  const bindings = createInMemoryDomainBindingStore();
  await bindings.put({ ...verified(), host: "customer.example" });
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    subsystems: { auth: false, database: false },
    domainBindings: bindings,
  });

  for (const host of [
    "customer.example.",
    "CUSTOMER.example",
    "customer.example:8443",
    "customer.example.:8443",
  ]) {
    for (const path of ["/zelavis", "/zelavis/", "/zelavis/api/v1/runtime/projects"]) {
      const response = await runtime.fetch(new Request(`http://${host}${path}`));
      assert.equal(response.status, 404, `${host}${path}`);
    }
  }
});

test("an unverified binding does not hide the dashboard", async () => {
  const bindings = createInMemoryDomainBindingStore();
  await bindings.put({ ...verified(), host: "pending.example", verifiedAt: undefined });
  const runtime = await zelavis({
    frontend: zelavisUiFrontend,
    subsystems: { auth: false, database: false },
    domainBindings: bindings,
  });
  const response = await runtime.fetch(new Request("http://pending.example/zelavis"));
  assert.notEqual(response.status, 404);
});

test('site ingress preserves login cookies and public Host, and rewrites private redirects', async () => {
  const server = createServer(async (request,response) => {
    if (request.url === '/redirect') {
      response.setHeader('location', `http://127.0.0.1:${server.address().port}/wp-admin/`);
      response.setHeader('set-cookie', ['wordpress_logged_in=site; Path=/', 'zelavis_access=attack; Path=/']);
      response.writeHead(302); response.end(); return;
    }
    const chunks=[]; for await (const chunk of request) chunks.push(chunk);
    response.end(JSON.stringify({path:request.url,headers:request.headers,body:Buffer.concat(chunks).toString()}));
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const site={url:`http://127.0.0.1:${server.address().port}`};
  try {
    const response=await forwardPublicRequest(platform(site),new Request('http://example.com:42000/wp-login.php',{
      method:'POST',body:'log=owner',headers:{cookie:'zelavis_access=secret; wordpress_logged_in=site', 'x-forwarded-host':'evil.test', 'x-forwarded-proto':'https', 'x-zelavis-authority':'attack'},
    }));
    const body=JSON.parse(new TextDecoder().decode(response.body));
    assert.equal(body.headers.host,'example.com:42000');
    assert.equal(body.headers['x-forwarded-proto'],'http');
    assert.equal(body.headers.cookie,'wordpress_logged_in=site');
    assert.equal(body.headers['x-zelavis-authority'],undefined);
    assert.equal(body.body,'log=owner');
    const directory=await forwardPublicRequest(platform(site),new Request('http://example.com:42000/wp-admin/'));
    assert.equal(directory.status,200);
    assert.equal(JSON.parse(new TextDecoder().decode(directory.body)).path,"/wp-admin/");
    const redirect=await forwardPublicRequest(platform(site),new Request('http://example.com:42000/redirect'));
    assert.equal(redirect.headers.get('location'),'http://example.com:42000/wp-admin/');
    assert.deepEqual(redirect.headers.getSetCookie(),['wordpress_logged_in=site; Path=/']);
    for(const path of ['/zelavis/api/v1/runtime','/%7aelavis/api/v1/runtime','//zelavis/']) {
      assert.equal((await forwardPublicRequest(platform(site),new Request(`http://example.com${path}`))).status,404);
    }
  } finally { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});


test("ingress cancels oversized request and response streams at its bound", async () => {
  let cancelled=false;
  const stream=()=>new ReadableStream({start(controller){controller.enqueue(new Uint8Array(32*1024*1024+1));},cancel(){cancelled=true;}});
  const project={id:"site",runtime:{status:"running",url:"http://127.0.0.1:1"}};
  const options={project,projects:{listOwned:async()=>[]},fetchSite:async()=>{throw Error("oversized request must not be fetched");}};
  const request=new Request("http://example.com/upload",{method:"POST",body:stream(),duplex:"half"});
  assert.equal((await forwardProjectSiteRequest(options,request)).status,413);
  assert.equal(cancelled,true);
  cancelled=false;
  const response=await forwardProjectSiteRequest({...options,fetchSite:async()=>new Response(stream())},new Request("http://example.com/"));
  assert.equal(response.status,502);
  assert.equal(cancelled,true);
});

const authBase = "/zelavis/api/v1/auth";
const appCookieName = (id) => `zelavis_app_${createHash("sha256").update(id).digest("hex").slice(0, 24)}`;
/** An access token shaped like one an App's Auth signs: only its issuer matters to the forwarder. */
const accessToken = (issuer) => [{ alg: "ES256" }, { iss: issuer, sub: "s" }, "signature"]
  .map((part) => Buffer.from(typeof part === "string" ? part : JSON.stringify(part)).toString("base64url")).join(".");
const siteAuthCookie = (id) => `${appCookieName(id)}=${accessToken(`zelavis:project:${id}`)}`;

test("only exact native App auth requests bypass a running server frontend", async () => {
  const options = platform({ url: "http://127.0.0.1:4001" }, {
    view: async () => ({ id: "site", recipe: { name: "@zelavis/app" }, runtime: { status: "running", url: "http://127.0.0.1:4001" } }),
    listOwned: async () => [{ id: "site-frontend", kind: "frontend", runtime: { status: "running", url: "http://127.0.0.1:4002" } }],
  });
  const calls = [];
  const own = siteAuthCookie("site");
  const sibling = siteAuthCookie("sibling");
  const token = own.split("=")[1];
  options.protectedCookieNames = ["custom_platform"];
  options.fetchSite = async (url, init) => {
    calls.push({ url, init });
    const headers = new Headers();
    for (const cookie of [own, sibling, "custom_platform=secret", "zelavis_access=platform", "site_theme=dark"]) headers.append("set-cookie", `${cookie}; Path=/`);
    return new Response("child", { headers });
  };
  const headers = { cookie: `${own}; ${sibling}; custom_platform=secret; zelavis_access=secret; zelavis_refresh=secret; site_theme=dark`,
    authorization: `Bearer ${token}`, "x-zelavis-authority": "inbound", "x-forwarded-host": "wrong.example", "x-forwarded-proto": "http" };
  const request = (path, init) => new Request(`https://EXAMPLE.com:4443${path}`, { headers, ...init });
  const response = await guardControlPlaneHost(options, request(`${authBase}/session`), "/ops/panel");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(response.headers.getSetCookie(), [`${own}; Path=/`]);
  const [{ url, init }] = calls;
  assert.equal(url.href, "http://127.0.0.1:4001/zelavis/_site-auth/GET/api/v1/auth/session");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.get("cookie"), own);
  assert.equal(init.headers.get("authorization"), `Bearer ${token}`);
  assert.equal(init.headers.get("x-zelavis-authority"), null);
  assert.equal(init.headers.get("host"), "example.com:4443");
  assert.equal(init.headers.get("x-forwarded-host"), "example.com:4443");
  assert.equal(init.headers.get("x-forwarded-proto"), "https");
  const site = await forwardPublicRequest(options, request("/"));
  assert.equal(calls.at(-1).url.port, "4002");
  assert.equal(calls.at(-1).init.headers.get("cookie"), "site_theme=dark");
  assert.equal(calls.at(-1).init.headers.get("authorization"), null);
  assert.deepEqual(site.headers.getSetCookie(), ["site_theme=dark; Path=/"]);

  // Neither a Platform access token nor a sibling App's reaches the App.
  for (const foreign of [accessToken("zelavis:platform:keys"), accessToken("zelavis:project:sibling")]) {
    await guardControlPlaneHost(options, request(`${authBase}/session`, { headers: { ...headers, authorization: `Bearer ${foreign}` } }), "/ops/panel");
    assert.equal(calls.at(-1).init.headers.get("authorization"), null);
  }

  for (const [method, path] of [
    ["GET", "/zelavis/forgot-password"], ["GET", "/zelavis/reset-password"], ["GET", "/zelavis/verify-email"],
    ["GET", "/zelavis/mfa"], ["GET", "/zelavis/oauth/callback"],
    ["GET", `${authBase}/methods`], ["GET", `${authBase}/jwks`], ["GET", `${authBase}/oauth/google/callback`],
    ["POST", `${authBase}/sign-up/password`], ["POST", `${authBase}/authenticate/password`], ["POST", `${authBase}/session/rotate`],
    ["POST", `${authBase}/email-password/sign-in`], ["POST", `${authBase}/email-password/recovery/start`],
    ["POST", `${authBase}/email-password/recovery/complete`], ["POST", `${authBase}/mfa/verify`],
    ["POST", `${authBase}/oauth/google/start`], ["POST", `${authBase}/username-passkey/sign-in/finish`],
    ["PATCH", `${authBase}/passkeys/key-1`], ["DELETE", `${authBase}/sessions/session-1`],
  ]) {
    const forwarded = await guardControlPlaneHost(options, request(path, { method }), "/ops/panel");
    assert.equal(forwarded.status, 200, `${method} ${path}`);
    assert.equal(calls.at(-1).url.pathname, `/zelavis/_site-auth/${method}${path.slice("/zelavis".length)}`);
    assert.equal(calls.at(-1).url.port, "4001");
  }

  const count = calls.length;
  for (const [method, path] of [
    ["GET", "/zelavis"], ["GET", "/zelavis/login/"], ["HEAD", "/zelavis/login"], ["POST", "/zelavis/login"],
    ["GET", "/%7aelavis/login"], ["GET", "/zelavis/%6cogin"], ["GET", "/zelavis//login"],
    ["GET", "/Zelavis/Login"], ["GET", "/zelavis%2flogin"], ["GET", "/zelavis%5clogin"],
    ["GET", "/zelavis/auth-assets/other.js"], ["GET", "/zelavis/_site-auth/GET/login"], ["GET", "/ops/panel/login"],
    ["GET", `${authBase}/accounts`], ["GET", `${authBase}/registration/settings`],
    ["GET", `${authBase}/email/verify`], ["POST", `${authBase}/recovery/other`],
    ["PUT", `${authBase}/registration/settings`], ["GET", "/zelavis/api/v1/email/settings"],
    ["GET", `${authBase}/oauth/connections`], ["PUT", `${authBase}/oauth/connections/google`],
    ["GET", `${authBase}/methods/settings`], ["GET", `${authBase}/passkeys/settings`], ["PATCH", `${authBase}/passkeys/settings`],
    ["GET", `${authBase}/mfa/policy`], ["POST", `${authBase}/keys/rotate`], ["GET", `${authBase}/security/events`],
    ["PUT", `${authBase}/session`], ["GET", `${authBase}/session/rotate`],
  ]) assert.equal((await guardControlPlaneHost(options, request(path, { method }), "/ops/panel")).status, 404, `${method} ${path}`);
  assert.equal((await guardControlPlaneHost(options, request("/zelavis/login"), "/ops/panel", false)).status, 404);
  const oversized = await guardControlPlaneHost(options, request(`${authBase}/username-password/sign-up`, { method: "POST", body: "x".repeat(8193) }), "/ops/panel");
  assert.equal(oversized.status, 413);
  assert.equal(calls.length, count);

  for (const [project, status] of [
    [undefined, 404],
    [{ id: "site", recipe: { name: "@acme/wordpress", managed: {} }, runtime: { status: "running", url: "http://127.0.0.1:4001" } }, 404],
    [{ id: "site", recipe: { name: "@zelavis/app" }, runtime: { status: "stopped" } }, 503],
  ]) {
    const unavailable = { ...options, projects: () => ({ ...options.projects(), view: async () => project }) };
    assert.equal((await guardControlPlaneHost(unavailable, request("/zelavis/login"), "/ops/panel")).status, status);
  }
  assert.equal(calls.length, count);
  const older = { ...options, fetchSite: async (url, init) => {
    assert.equal(init.method, "POST");
    assert.equal(url.pathname, "/zelavis/_site-auth/POST/api/v1/auth/username-password/sign-up");
    return new Response("Not found", { status: 404 });
  } };
  assert.equal((await guardControlPlaneHost(older, request(`${authBase}/username-password/sign-up`, { method: "POST", body: "{}" }), "/ops/panel")).status, 404);
});

test("a verified HTTPS origin reaches the exact native engine, cookie and SDK session", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-verified-app-auth-"));
  const domainBindings = createInMemoryDomainBindingStore();
  const forwardedCookies = [];
  const node = nodeAdapter({ dataDirectory: directory });
  const adapter = defineAdapter({ ...node,
    async resolve(options) {
      const resolved = await node.resolve(options);
      return { ...resolved,
        resources: { ...resolved.resources, domainBindings, publicSiteFetch: (url, init) => {
          forwardedCookies.push(new Headers(init.headers).get("cookie"));
          return fetchNodeSite(url, init);
        } },
      };
    },
  });
  const instance = new Zelavis({ rootPath: "/ops/panel", adapter });
  t.after(async () => { await instance.close(); await rm(directory, { recursive: true, force: true }); });
  const runtime = await instance.runtime();
  const projects = runtime.endpointGroups["platform.control-plane"].context.projects;
  for (const id of ["site", "sibling"]) {
    await projects.create({ id, name: id, recipeName: "@zelavis/app", start: true });
    await domainBindings.put({ ...verified(id), host: `${id}.example.com` });
  }
  const origin = "https://site.example.com";
  const sibling = "https://sibling.example.com";
  const send = (path, init, host = origin) => runtime.fetch(new Request(`${host}${path}`, init));
  assert.equal((await send("/ops/panel/login")).status, 404);
  assert.equal((await send("/zelavis/sign-up")).status, 404);
  await send("/", { headers: { cookie: "zelavis_access=secret; zelavis_refresh=secret; site_theme=dark" } });
  assert.equal(forwardedCookies.at(-1), "site_theme=dark");
  const settings = "/ops/panel/api/v1/runtime/projects/site/auth/registration/settings";
  const change = await runtime.dispatch(new Request(`http://platform.local${settings}`, { method: "PUT",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, expectedRevision: 0 }) }),
  { principal: { id: "operator", type: "system", permissions: ["*"] } });
  assert.equal(change.response.status, 200, await change.response.text());
  const login = await send("/zelavis/login");
  assert.equal(login.status, 200);
  assert.match(login.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await login.text(), /href="\/zelavis\/sign-up"/);
  const closedSibling = await send("/zelavis/sign-up", undefined, sibling);
  assert.equal(closedSibling.status, 404, await closedSibling.text());
  const asset = await send("/zelavis/auth-assets/identity.js");
  assert.match(asset.headers.get("content-type"), /javascript/);
  assert.ok((await asset.text()).length > 100);

  assert.equal((await send(`${authBase}/authenticate/password`, { method: "POST" })).status, 404,
    "Only a published worker can accept a published sign-in route");
  const input = { username: "app-user", password: "a long unique App password" };
  const json = { "content-type": "application/json" };
  const signUp = await send(`${authBase}/username-password/sign-up`, { method: "POST", headers: { origin, ...json }, body: JSON.stringify(input) });
  assert.equal(signUp.status, 200, await signUp.clone().text());
  const enrolled = await signUp.json();
  assert.equal(enrolled.tokens, undefined, "a page of the App's origin gets cookies, never tokens");
  const [access, refresh] = signUp.headers.getSetCookie();
  assert.match(access, new RegExp(`^${appCookieName("site")}=.+; Path=/zelavis/api/v1; HttpOnly; SameSite=Lax; Secure`, "i"));
  assert.match(refresh, new RegExp(`^${appCookieName("site")}_refresh=.+; Path=/zelavis/api/v1/auth/session`, "i"));
  for (const cookie of [access, refresh]) assert.doesNotMatch(cookie, /Domain=/i);
  const cookie = access.split(";", 1)[0];
  const session = await (await send(`${authBase}/session`, { headers: { cookie } })).json();
  assert.equal(session.account.id, enrolled.userId);
  assert.deepEqual(session.account.roles, ["user"]);
  // A native client signs in with the token bundle, and its access token is the App's alone.
  const bearerSignIn = await send(`${authBase}/username-password/sign-in`, {
    method: "POST", headers: { ...json, origin, "x-zelavis-auth-mode": "bearer" }, body: JSON.stringify(input),
  });
  assert.equal(bearerSignIn.headers.has("set-cookie"), false);
  const signedIn = await bearerSignIn.json();
  assert.equal(signedIn.userId, enrolled.userId);
  assert.equal((await send(`${authBase}/session`, { headers: { authorization: `Bearer ${signedIn.tokens.accessToken}` } })).status, 200);
  assert.equal((await send(`${authBase}/session`, { headers: { cookie, authorization: `Bearer ${signedIn.tokens.accessToken}` } }, sibling)).status, 401);
  assert.equal((await send(`${authBase}/session`, { method: "DELETE", headers: { cookie, origin: sibling } })).status, 403);
  assert.equal((await send(`${authBase}/session`, { headers: { cookie } })).status, 200, "a sibling origin cannot end this App's session");
  // The Platform's own Auth is not reachable on the App's origin, and an App token means nothing to the Platform.
  assert.equal((await send(`${authBase}/accounts`, { headers: { cookie } })).status, 404);
  assert.equal((await runtime.fetch(new Request(`http://platform.local/ops/panel/api/v1/auth/session`, { headers: { authorization: `Bearer ${signedIn.tokens.accessToken}` } }))).status, 401);
  const logout = await send(`${authBase}/session`, { method: "DELETE", headers: { cookie, origin } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.getSetCookie()[0], new RegExp(`^${appCookieName("site")}=;.*Max-Age=0`, "i"));
  assert.equal((await send(`${authBase}/session`, { headers: { cookie } })).status, 401);
  await projects.stop("site");
  assert.equal((await send("/zelavis/login")).status, 503);
});

test("the packaged auth frontend uses the configured mount and exact assets", async (t) => {
  const calls = [];
  const runtime = await zelavis({ rootPath: "/ops/identity", api: { prefix: "/endpoint", version: "v9" },
    frontend: context => zelavisUiIdentityFrontend({ ...context, fetch: async request => {
      calls.push(new URL(request.url).pathname);
      return Response.json({
        registration: { enabled: false },
        methods: [{ name: "emailPassword", signIn: true, signUp: false, recovery: true }],
      });
    } }), subsystems: { auth: false, database: false },
  });
  t.after(() => runtime.close());
  const get = path => runtime.fetch(new Request(`http://app.example${path}`));
  const login = await get("/ops/identity/login");
  assert.equal(login.status, 200);
  const html = await login.text();
  assert.match(html, /data-api="\/ops\/identity\/endpoint\/v9"/);
  assert.match(html, /src="\/ops\/identity\/auth-assets\/identity.js"/);
  assert.doesNotMatch(html, /href="[^\"]*sign-up/);
  const closed = await get("/ops/identity/sign-up");
  assert.equal(closed.status, 404);
  assert.doesNotMatch(await closed.text(), /<form/);
  assert.deepEqual(calls, [
    "/ops/identity/endpoint/v9/auth/methods",
    "/ops/identity/endpoint/v9/auth/methods",
  ]);
  for (const page of ["forgot-password", "reset-password", "verify-email", "mfa", "oauth/callback"]) {
    const response = await get(`/ops/identity/${page}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.ok(body.includes(`data-path="/${page}"`));
    assert.ok(body.includes('href="/ops/identity/login"'));
  }
  assert.match((await get("/ops/identity/auth-assets/identity.css")).headers.get("content-type"), /text\/css/);
  for (const path of ["/ops/identity/login/", "/ops/identity/projects", "/ops/identity/auth-assets/extra.js"]) assert.equal((await get(path)).status, 404);
});

test("native App provider callbacks preserve exact bytes and signatures without exposing service administration", async () => {
  const { isProjectServiceWebhook, publicRequestFromPrivateAuth } = await import("../dist/platform/project-public-auth.js");
  const path = "/zelavis/api/v1/plugins/payments/webhooks/gateway";
  assert.ok(isProjectServiceWebhook("POST", path));
  for (const [method, candidate] of [["GET", path], ["POST", path + "/extra"], ["POST", "/zelavis/api/v1/plugins/payments/settings"], ["POST", "/zelavis/api/v1/auth/admin/accounts"]]) assert.equal(isProjectServiceWebhook(method, candidate), false);
  let received;
  const options = {
    rootPath: "/zelavis", project: { id: "app", recipe: { name: "@zelavis/app" }, runtime: { status: "running", url: "http://127.0.0.1:43210" } },
    projects: { listOwned: async () => [] },
    fetchSite: async (url, init) => {
      const original = publicRequestFromPrivateAuth(new Request(url, init));
      assert.ok(original);
      received = { body: await original.text(), signature: original.headers.get("provider-signature"), authority: original.headers.get("authorization"), cookie: original.headers.get("cookie"), pathname: new URL(original.url).pathname };
      return new Response("ok");
    },
  };
  const body = " ".repeat(10000) + '{"id":"signed"}';
  const response = await forwardProjectSiteRequest(options, new Request(`https://app.example${path}`, { method: "POST", headers: { "provider-signature": "exact-signature", authorization: "Bearer platform-secret", cookie: "zelavis_access=platform-secret" }, body }));
  assert.equal(response.status, 200);
  assert.deepEqual(received, { body, signature: "exact-signature", authority: null, cookie: null, pathname: path });
  assert.equal((await forwardProjectSiteRequest(options, new Request(`https://app.example${path}`, { method: "POST", body: "x".repeat(262145) }))).status, 413);
  assert.equal((await forwardProjectSiteRequest(options, new Request("https://app.example/zelavis/api/v1/plugins/payments/settings", { method: "POST", body: "{}" }))).status, 404);
});
