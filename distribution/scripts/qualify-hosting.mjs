import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const key = process.env.STRIPE_TEST_SECRET_KEY;
const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../..", import.meta.url));
const webhookPath = "/zelavis/api/v1/plugins/ecommerce/webhooks/stripe";
const events = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded",
  "customer.subscription.updated", "customer.subscription.deleted", "invoice.paid", "invoice.payment_failed",
];
const cliEnv = { ...process.env };
delete cliEnv.STRIPE_TEST_SECRET_KEY;
delete cliEnv.STRIPE_API_KEY;

async function stripeCli(args) {
  try {
    const result = await exec("stripe", args, { env: cliEnv, timeout: 30_000, maxBuffer: 256 * 1024 });
    return result.stdout.trim();
  } catch (error) {
    throw new Error(error.code === "ENOENT" ? "Install the Stripe CLI and run stripe login in the test account." :
      `Stripe CLI ${args[0]} failed. Verify its sandbox login and permissions.`);
  }
}

const cancelSubscription = id => stripeCli(["delete", `/v1/subscriptions/${id}`, "--confirm"]);

async function stripeGet(path) {
  const response = await fetch(`https://api.stripe.com${path}`, {
    headers: { authorization: `Bearer ${key}` }, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Stripe's test API returned HTTP ${response.status}.`);
  return response.json();
}

async function poll(label, read, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function localPackages(data, clock) {
  const source = join(repo, "zelavis-services");
  const root = join(data, "services-checkout");
  for (const [name, path] of [["ecommerce", "ecommerce"], ["stripe", "ecommerce/plugins/stripe"], ["hosting", "hosting"]]) {
    const target = join(root, name);
    await mkdir(target, { recursive: true });
    for (const file of ["package.json", "dist", "dashboard"]) {
      await cp(join(source, path, file), join(target, file), { recursive: true });
    }
  }
  // Keep the checkout's artifacts intact. Only the isolated copy receives the qualification clock.
  const symbol = `zelavis.qualify.hosting.${randomUUID()}`;
  globalThis[Symbol.for(symbol)] = clock;
  const manifestPath = join(root, "hosting/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports = "./qualification.mjs";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(root, "hosting/qualification.mjs"), `
    import { createHostingPlugin, registerHostingMenu } from "./dist/hosting-plugin.js";
    export function register() { registerHostingMenu(); }
    const clock = globalThis[Symbol.for(${JSON.stringify(symbol)})];
    export default createHostingPlugin({ now: () => clock.now, workerIntervalMs: 250 });
  `);
  return root;
}

function forwardWebhooks(args) {
  const child = spawn("stripe", args, { env: cliEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", failure;
  const consume = buffer => { output = (output + buffer.toString("utf8")).slice(-4096); };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  child.once("error", error => { failure = error; });
  const closed = new Promise(resolve => child.once("close", resolve));
  return {
    ready: secret => poll("the Stripe CLI webhook listener", () => {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error("Stripe webhook forwarding exited before it was ready.");
      const receivedSecret = /whsec_[A-Za-z0-9]+/u.exec(output)?.[0];
      if (!receivedSecret) return false;
      if (receivedSecret !== secret) throw new Error("The two Stripe CLI invocations returned different signing secrets.");
      return true;
    }, 25_000),
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      const stopped = await Promise.race([closed.then(() => true), delay(5000, false, { ref: false })]);
      if (!stopped) {
        child.kill("SIGKILL");
        await closed;
      }
    },
  };
}

async function checkoutInChromium(chromium, url, origin, name, email) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30_000);
    const checkout = new URL(url);
    assert.equal(checkout.origin, "https://checkout.stripe.com");
    const sessionId = /\/((?:cs_test_)[A-Za-z0-9]+)(?:\/|$)/u.exec(checkout.pathname)?.[1];
    assert.ok(sessionId, "Expected a Stripe test Checkout Session.");
    await page.goto(checkout.href, { waitUntil: "domcontentloaded" });
    const found = await poll("the Stripe Checkout card form", async () => {
      for (const frame of page.frames()) {
        if (frame.isDetached()) continue;
        if (await frame.locator("#payment-numberInput").isVisible()) return { scope: frame, habanero: true };
        if (await frame.locator("#cardNumber").isVisible()) return { scope: frame, habanero: false };
        const cardButton = frame.getByRole("button", { name: /^Card$/u });
        if (await cardButton.isVisible()) {
          await cardButton.click();
          return { scope: frame, habanero: frame.url().includes("elements-inner") };
        }
      }
      return false;
    }, 30_000);
    const { scope, habanero } = found;
    const card = scope.locator(habanero ? "#payment-numberInput" : "#cardNumber");
    const emailInput = scope.locator("#linkAuthentication-emailInput");
    if (await emailInput.isVisible() && !(await emailInput.inputValue())) {
      await emailInput.fill(email);
    }
    await card.fill("4242424242424242");
    await scope.locator(habanero ? "#payment-expiryInput" : "#cardExpiry").fill(`12${String(new Date().getFullYear() + 2).slice(-2)}`);
    await scope.locator(habanero ? "#payment-cvcInput" : "#cardCvc").fill("123");
    const nameInput = scope.locator(habanero ? "#payment-nameInput" : "#billingName");
    if (await nameInput.isVisible()) await nameInput.fill(name);
    const countryInput = scope.locator(habanero ? "#payment-countryInput" : "#billingCountry");
    if (await countryInput.isVisible()) await countryInput.selectOption("US");
    const postalInput = scope.locator(habanero ? "#payment-postalCodeInput" : "#billingPostalCode");
    if (await postalInput.isVisible()) await postalInput.fill("10001");
    await scope.getByRole("button", { name: /^(Subscribe|Pay and subscribe|Pay)$/u }).click();
    await page.waitForURL(next => next.origin === origin && next.searchParams.get("hosting") === "checkout-done", { timeout: 60_000 });
  } finally {
    await browser.close();
  }
}

async function qualify() {
  if (!/^sk_test_[A-Za-z0-9]+$/u.test(key ?? "")) {
    throw new Error("Set STRIPE_TEST_SECRET_KEY to a Stripe test-mode secret and log the Stripe CLI into the same sandbox.");
  }
  const cliAccountJson = await stripeCli(["get", "/v1/account"]);
  let cliAccount;
  try { cliAccount = JSON.parse(cliAccountJson); }
  catch { throw new Error("Stripe CLI did not return the signed-in account."); }
  const testAccount = await stripeGet("/v1/account");
  if (typeof cliAccount.id !== "string" || cliAccount.id !== testAccount.id) {
    throw new Error("Stripe CLI login and STRIPE_TEST_SECRET_KEY must belong to the same Stripe sandbox.");
  }

  const [{ Zelavis }, { nodeAdapter }, { createNodeServer, closeNodeServer }, { createZelavisClient }, { startSmtpServer, parseMessage, testCertificate }] =
    await Promise.all([
      import("../../packages/zelavis/dist/index.js"), import("../../packages/zelavis/dist/adapters/node.js"),
      import("../../packages/zelavis/dist/runtimes/node.js"), import("../../packages/zelavis/dist/sdk/fetch.js"),
      import("../../packages/zelavis/test/_smtp-server.mjs"),
    ]);
  const requireUi = createRequire(new URL("../../packages/zelavis/services/zelavis-ui/package.json", import.meta.url));
  const { chromium } = requireUi("@playwright/test");
  const data = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "zv-qualify-hosting-"));
  const defaults = getCACertificates("default");
  const smtpClosers = [];
  let platform, server, listener, sessionId, subscriptionId, cancelled;
  let stage = "start the local Platform";
  const uid = randomUUID();
  const clock = { now: Date.now() };
  const name = "Zelavis Hosting Qualification";
  const email = `hosting-${uid}@example.test`;
  const password = randomBytes(32).toString("base64url");
  const bootstrapToken = randomBytes(32).toString("base64url");
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const officialServicesDirectory = await localPackages(data, clock);
    platform = new Zelavis({ bootstrap: { token: bootstrapToken }, adapter: nodeAdapter({
      dataDirectory: join(data, "platform"), terminal: false, projects: { previewHost: false },
      services: { marketplace: { sources: [], officialServicesDirectory } },
    }) });
    // The in-process dev adapter recomposes on install. Open the listener once the three services are active.
    const bootstrap = createZelavisClient({ baseUrl: "http://localhost", fetch: (input, init) =>
      platform.fetch(new Request(input, init)) });
    const claim = await bootstrap.auth.bootstrap.claim({ bootstrapToken, username: "owner", password });
    const token = claim.tokens.accessToken;
    const localOwner = createZelavisClient({ baseUrl: "http://localhost", fetch: (input, init) => platform.fetch(new Request(input, init)),
      headers: { authorization: `Bearer ${token}` } });
    const manifest = JSON.parse(await readFile(join(officialServicesDirectory, "hosting/package.json"), "utf8"));
    for (const [service, approvePermissions] of [
      ["@zelavis/ecommerce"], ["@zelavis/ecommerce-stripe"], ["@zelavis/hosting", manifest.zelavis.principal.permissions],
    ]) {
      await localOwner.services.update(service, { status: "installed", approvePermissions });
    }
    server = await createNodeServer(platform);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = `http://127.0.0.1:${server.address().port}`;
    const client = accessToken => createZelavisClient({
      baseUrl: origin, headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined,
      fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90_000)]) }),
    });
    const owner = client(token);
    const anonymous = client();

    stage = "configure local SMTP and Stripe test webhooks";
    setDefaultCACertificates([...defaults, (await testCertificate()).cert]);
    const smtp = await startSmtpServer({ after: close => smtpClosers.push(close) }, { tls: "implicit" });
    await owner.email.setSettings({ expectedRevision: 0, mode: "smtp", from: { address: "hosting@example.test" },
      smtp: { host: smtp.host, port: smtp.port, security: "tls" }, linkBaseUrl: `${origin}/zelavis` });
    await owner.auth.registration.setSettings({ expectedRevision: 0, enabled: true });
    const forwardArgs = ["listen", "--latest", "--events", events.join(","), "--forward-to", `${origin}${webhookPath}`];
    const webhookSecret = await stripeCli([...forwardArgs, "--print-secret"]);
    assert.match(webhookSecret, /^whsec_[A-Za-z0-9]+$/u);
    await owner.plugins.stripe.settings.set({ secretKey: key, webhookSecret });
    listener = forwardWebhooks(forwardArgs);
    await listener.ready(webhookSecret);

    stage = "create a plan and verify the customer";
    await owner.plugins.hosting.settings.set({ publicBaseUrl: origin, provider: "stripe", graceDays: 1 });
    await owner.plugins.hosting.plans.save({
      title: "Hosting Qualification", price: { amount: 1200, currency: "usd", interval: "month" },
      limits: { projects: 1, recipes: ["@zelavis/app"] },
      projectPermissions: ["project.view", "project.runtime.manage", "project.logs.read"], active: true,
    }, { params: { planId: "qualification" } });
    const { browserSecret } = await anonymous.auth.emailPassword.signUp({ email, password });
    const delivered = await poll("the email verification message", () => smtp.messages.find(message => message.to === email), 20_000);
    const text = parseMessage(delivered.data).parts.find(part => part.type === "text/plain")?.body ?? "";
    const emailCode = /#code=([A-Za-z0-9_-]+)/u.exec(text)?.[1];
    assert.ok(emailCode);
    const customer = await anonymous.auth.emailPassword.completeSignUp({ emailCode, browserSecret });
    let signedIn = client(customer.tokens.accessToken);

    stage = "complete the Stripe test Checkout and wait for verified fulfillment";
    const { url } = await signedIn.plugins.hosting.checkout.create({ planId: "qualification" });
    sessionId = /\/(cs_test_[A-Za-z0-9]+)(?:\/|$)/u.exec(new URL(url).pathname)?.[1];
    await checkoutInChromium(chromium, url, origin, name, email);
    const active = await poll("the verified active subscription", async () => {
      const { subscription } = await signedIn.plugins.hosting.subscription.get();
      return subscription.state === "active" && subscription;
    });
    console.log("PASS subscribe");

    stage = "create a Project and exercise the plan limit";
    const { projectId } = await signedIn.plugins.hosting.projects.create({ name: "Stripe test Project" });
    const created = await owner.projects.get(projectId);
    assert.equal(created.runtime.status, "running");
    console.log("PASS project");
    const login = () => anonymous.auth.emailPassword.signIn({ email, password });
    signedIn = client((await login()).tokens.accessToken);
    await assert.rejects(signedIn.plugins.hosting.projects.create({ name: "Second Project" }),
      error => error.status === 409 && error.body?.error === "plan_limit_reached");
    console.log("PASS limit");

    stage = "cancel the Stripe test subscription and reconcile suspension";
    const getBilling = () => owner.plugins.ecommerce.subscriptions.getById(undefined, { params: { id: active.ecommerceSubscriptionId } });
    const billing = await getBilling();
    subscriptionId = billing.reference;
    assert.match(subscriptionId ?? "", /^sub_[A-Za-z0-9]+$/u);
    // Stripe event timestamps have second precision. Keep cancel strictly newer than Checkout.
    const untilNewer = Date.parse(active.providerUpdatedAt) + 1000 - Date.now();
    if (untilNewer > 0) await delay(untilNewer);
    const result = JSON.parse(await cancelSubscription(subscriptionId));
    assert.equal(result.livemode, false);
    assert.equal(result.id, subscriptionId);
    assert.equal(result.status, "canceled");
    cancelled = true;
    const cancelledBilling = await poll("the signed cancellation", async () => {
      const subscription = await getBilling();
      return subscription.status === "cancelled" && subscription;
    });
    const periodEnd = Date.parse(cancelledBilling.currentPeriodEnd ?? "") || Date.now();
    clock.now = Math.max(periodEnd, Date.now()) + 86_400_001;
    await poll("suspended Project to stop", async () => (await owner.projects.get(projectId)).runtime.status === "stopped");
    signedIn = client((await login()).tokens.accessToken);
    assert.equal((await signedIn.plugins.hosting.subscription.get()).subscription.state, "suspended");
    await assert.rejects(signedIn.projects.start(projectId), { status: 403 });
    console.log("PASS suspend");
  } catch {
    // Failed provider and browser responses may embed keys, tokens or session URLs.
    throw new Error(`Hosting qualification failed while attempting to ${stage}.`);
  } finally {
    try {
      if (!cancelled && sessionId) {
        const session = await stripeGet(`/v1/checkout/sessions/${sessionId}`);
        if (session.livemode === false && typeof session.subscription === "string" && /^sub_[A-Za-z0-9]+$/u.test(session.subscription)) {
          await cancelSubscription(session.subscription);
        }
      }
    } catch {
      console.error("Could not confirm cancellation of the qualification subscription in Stripe test mode.");
      process.exitCode = 1;
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
      setDefaultCACertificates(defaults);
      const done = await Promise.allSettled([
        listener?.close(), server ? closeNodeServer(server) : undefined, ...smtpClosers.map(close => close()),
      ]);
      await platform?.close();
      await rm(data, { recursive: true, force: true });
      if (done.some(result => result.status === "rejected")) throw new Error("A Hosting qualification fixture could not be closed.");
    }
  }
}

try {
  await qualify();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
