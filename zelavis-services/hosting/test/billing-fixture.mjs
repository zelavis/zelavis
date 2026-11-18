import assert from "node:assert/strict";
import { randomUUID, createHmac } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { parseMessage, startSmtpServer, testCertificate } from "../../../packages/zelavis/test/_smtp-server.mjs";
import { createZelavisClient } from "../../../packages/zelavis/dist/sdk/fetch.js";
import { Zelavis } from "../../../packages/zelavis/dist/index.js";
import { nodeAdapter } from "../../../packages/zelavis/dist/adapters/node.js";
import { hostingManifest } from "./load-plugin.mjs";
import { waitFor } from "../../../packages/zelavis/test/_auth.mjs";

const commerceDirectory = fileURLToPath(new URL("../../ecommerce", import.meta.url));
const hostingDirectory = fileURLToPath(new URL("..", import.meta.url));
export const password = "a strong password for hosting tests";
const webhookSecret = "hosting-test-webhook-key";
const origin = "http://localhost";

export async function localServices(t, directory, fixture) {
  const scope = `zelavis.hosting.test.${randomUUID()}`;
  const key = Symbol.for(scope);
  globalThis[key] = fixture;
  t.after(() => { delete globalThis[key]; });
  const root = join(directory, "local-services");
  for (const [name, source] of [["ecommerce", commerceDirectory], ["hosting", hostingDirectory]]) {
    const target = join(root, name);
    await mkdir(target, { recursive: true });
    await cp(join(source, "package.json"), join(target, "package.json"));
    await cp(join(source, "dist"), join(target, "dist"), { recursive: true });
    await cp(join(source, "dashboard"), join(target, "dashboard"), { recursive: true });
  }
  const manifestPath = join(root, "hosting/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports = "./fixture.mjs";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(root, "hosting/fixture.mjs"), `
    import { createHostingPlugin, registerHostingMenu } from "./dist/hosting-plugin.js";
    export function register() { registerHostingMenu(); }
    const fixture = globalThis[Symbol.for(${JSON.stringify(scope)})];
    const plugin = createHostingPlugin({ now: () => fixture.now, workerIntervalMs: 50 });
    export default { ...plugin, setup(context) {
      const original = context.core.fetch;
      return plugin.setup({ ...context, core: { ...context.core, fetch: request =>
        fixture.platformFetch?.(request, original) ?? original(request) } });
    } };
  `);
  const fake = join(root, "fake-payment");
  await mkdir(fake);
  await writeFile(join(fake, "package.json"), JSON.stringify({
    name: "@test/hosting-payment", version: "1.0.0", type: "module", exports: "./index.js",
    zelavis: { kind: "plugin", namespace: "hostingTestPayment", capabilities: ["@zelavis/ecommerce:payments"] },
  }));
  await writeFile(join(fake, "index.js"), `
    import { createHmac, timingSafeEqual } from "node:crypto";
    const fixture = globalThis[Symbol.for(${JSON.stringify(scope)})];
    const secret = ${JSON.stringify(webhookSecret)};
    export default { service: { register(api) {
      fixture.commerce = api;
      return api.runPromise(api.payments.registerProvider("fake", {
        createPayment() { throw new Error("Unused"); },
        async createCheckout(input) {
          fixture.checkouts.push(input);
          return { reference: "cs_" + input.checkoutId, url: "https://checkout.example/" + input.checkoutId,
            customerReference: "cus_" + input.customer.id };
        },
        async createPortal(input) { return { url: "https://billing.example/" + input.customer.id }; },
        async parseWebhook({ headers, rawBody }) {
          const signature = headers.get("signature") ?? "";
          const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
          if (signature.length !== expected.length ||
              !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("Invalid signature");
          return JSON.parse(rawBody).map(event => ({ ...event, occurredAt: new Date(event.occurredAt),
            ...(event.currentPeriodEnd ? { currentPeriodEnd: new Date(event.currentPeriodEnd) } : {}) }));
        }
      }));
    } } };
  `);
  return { sources: [], officialServicesDirectory: root };
}

export async function customers(t, { instance, send }, bootstrapToken) {
  const bootstrap = await send("POST", "/auth/bootstrap", { bootstrapToken, username: "owner", password }, null);
  assert.equal(bootstrap.status, 201);
  const defaults = getCACertificates("default");
  const { cert } = await testCertificate();
  setDefaultCACertificates([...defaults, cert]);
  t.after(() => setDefaultCACertificates(defaults));
  const smtp = await startSmtpServer(t, { tls: "implicit" });
  const configured = await send("PUT", "/email/settings", {
    expectedRevision: 0, mode: "smtp", from: { address: "hosting@example.test" },
    smtp: { host: smtp.host, port: smtp.port, security: "tls" }, linkBaseUrl: "https://hosting.example/zelavis",
  });
  assert.equal(configured.status, 200, JSON.stringify(configured));
  const registration = await send("PUT", "/auth/registration/settings", { expectedRevision: 0, enabled: true });
  assert.equal(registration.status, 200, JSON.stringify(registration));

  const client = token => createZelavisClient({
    baseUrl: origin, fetch: (input, init) => instance.fetch(new Request(input, init)),
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  return async name => {
    const email = `${name}@example.test`;
    const { browserSecret } = await client().auth.emailPassword.signUp({ email, password });
    await waitFor(() => smtp.messages.some(message => message.to === email), { timeoutMs: 15000, what: "signup verification email" });
    const message = smtp.messages.find(message => message.to === email);
    const text = parseMessage(message.data).parts.find(part => part.type === "text/plain")?.body ?? "";
    const code = /#code=([A-Za-z0-9_-]+)/u.exec(text)?.[1];
    assert.ok(code);
    const signedIn = await client().auth.emailPassword.completeSignUp({ emailCode: code, browserSecret });
    assert.ok(signedIn.tokens?.accessToken);
    return {
      id: signedIn.userId, client: client(signedIn.tokens.accessToken), token: signedIn.tokens.accessToken,
      signIn: async () => client((await client().auth.emailPassword.signIn({ email, password })).tokens.accessToken),
    };
  };
}

export async function webhook(instance, events, valid = true) {
  const body = JSON.stringify(events);
  const signature = valid ? createHmac("sha256", webhookSecret).update(body).digest("hex") : "invalid";
  return instance.fetch(new Request(`${origin}/zelavis/api/v1/plugins/ecommerce/webhooks/fake`, {
    method: "POST", headers: { "content-type": "application/json", signature }, body,
  }));
}

export const hosting = "/plugins/hosting/hosting";
const bootstrapToken = "hosting-bootstrap-token-for-tests";
const owner = { id: "owner", type: "user", roles: ["owner"], permissions: ["*"] };
export const permissions = hostingManifest.zelavis.principal.permissions;

export async function platform(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zv-hosting-"));
  const { billing, frontend, ...adapter } = options;
  const marketplace = billing ? await localServices(t, directory, billing)
    : { sources: [], officialServicesDirectory: new URL("../..", import.meta.url).pathname };
  const instance = new Zelavis({ adapter: nodeAdapter({
    dataDirectory: directory, projects: false, terminal: false,
    services: { marketplace },
    ...adapter,
  }), frontend, bootstrap: { token: bootstrapToken } });
  t.after(async () => {
    await instance.close();
    await rm(directory, { recursive: true, force: true });
  });
  const send = async (method, path, body, principal = owner) => {
    const response = await instance.fetch(new Request(`http://localhost/zelavis/api/v1${path}`, {
      method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    }), { principal });
    return { status: response.status, body: await response.json() };
  };
  const service = (name, status, approvePermissions) =>
    send("PATCH", `/runtime/services/${encodeURIComponent(name)}`, { status, approvePermissions });
  return { instance, send, service };
}

export const starter = {
  title: "Starter", price: { amount: 1200, currency: "usd", interval: "month" },
  limits: { projects: 2, recipes: ["@zelavis/app"] },
  projectPermissions: ["project.view", "project.runtime.manage", "project.logs.read", "project.delete"],
  active: true,
};

export async function readyBilling(t, options = {}) {
  const billing = { checkouts: [], now: Date.now() };
  const fixture = await platform(t, { billing, ...options });
  for (const [name, approval] of [["@zelavis/ecommerce"], ["@test/hosting-payment"], ["@zelavis/hosting", permissions]]) {
    const result = await fixture.service(name, "installed", approval);
    assert.equal(result.status, 200, JSON.stringify(result));
  }
  const settings = await fixture.send("PUT", `${hosting}/settings`, { publicBaseUrl: "https://hosting.example", provider: "fake" });
  assert.equal(settings.status, 200, JSON.stringify(settings));
  const saved = await fixture.send("PUT", `${hosting}/plans/starter`, starter);
  assert.equal(saved.status, 200, JSON.stringify(saved));
  const createCustomer = await customers(t, fixture, bootstrapToken);
  const postEvent = async event => {
    const response = await webhook(fixture.instance, [event]);
    assert.equal(response.status, 200, await response.text());
    await billing.commerce.runPromise(billing.commerce.fulfillment.deliver());
  };
  const complete = async () => {
    const input = billing.checkouts.at(-1);
    await postEvent({ eventId: `checkout-${input.checkoutId}`, type: "checkout.completed", occurredAt: new Date(++billing.now).toISOString(),
      checkoutReference: `cs_${input.checkoutId}`, subscriptionReference: `sub_${input.checkoutId}` });
    return input;
  };
  return { ...fixture, billing, createCustomer, postEvent, complete };
}
