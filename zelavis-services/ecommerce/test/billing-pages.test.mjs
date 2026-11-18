import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { once } from "node:events";
import { createMemorySystemStore, zelavis } from "../../../packages/zelavis/dist/index.js";
import { loadPluginPackage } from "../../../packages/zelavis/dist/service.js";
import { resolveLocalPackageManifest } from "../../../packages/zelavis/dist/adapters/_local-runtime.js";
import { loadEcommercePlugin } from "./load-plugin.mjs";
const { chromium } = createRequire(new URL("../../../packages/zelavis/services/zelavis-ui/package.json", import.meta.url))("@playwright/test");
const owner = { id: "owner", type: "user", permissions: ["*"] };

test("billing pages work through opaque service frames at desktop and mobile sizes", async () => {
  const stripe = await loadPluginPackage({ manifest: resolveLocalPackageManifest(new URL("../plugins/stripe", import.meta.url).pathname), importer: () => import("../plugins/stripe/dist/index.js") });
  let api;
  const capture = { name: "@test/billing-page", namespace: "billingPage", kind: "plugin", capabilities: ["@zelavis/ecommerce:fulfillment"], service: { register(value) { api = value; } } };
  const runtime = await zelavis({ systemStore: createMemorySystemStore(), serviceRegistry: { catalog: [{ service: await loadEcommercePlugin(), status: "installed" }, { service: stripe, status: "installed" }, { service: capture, status: "installed" }] } });
  await api.runPromise(api.repositories.fulfillment.save({ id: "failed:hosting", messageId: "failed", handler: "hosting", attempts: 2, nextAttemptAt: Date.now() + 120000, lastError: "Fulfillment handler failed or timed out.", failed: true }));
  const server = createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/frame")) {
        const namespace = new URL(req.url, "http://local").searchParams.get("namespace");
        const capability = await runtime.plain({ url: `/zelavis/api/v1/runtime/service-page-capability?service=${encodeURIComponent(namespace === "stripe" ? "@zelavis/ecommerce-stripe" : "@zelavis/ecommerce")}&bundle=dashboard&file=${namespace === "stripe" ? "settings" : "payments"}.html`, principal: owner });
        assert.equal(capability.status, 200);
        const src = capability.body.src;
        res.setHeader("content-type", "text/html");
        res.end(`<iframe title="Service" sandbox="allow-scripts" src="${src}" style="width:100%;height:90vh;border:0"></iframe><script>
          const frame=document.querySelector('iframe'); window.addEventListener('message',async event=>{
            if(event.source!==frame.contentWindow||event.data?.zelavis!=='service-page-request')return;
            const d=event.data; if(!/^[a-zA-Z0-9?=_%./-]+$/.test(d.path)||d.path.includes('..')||d.path.startsWith('/'))throw Error('Bad frame path');
            const response=await fetch('/zelavis/api/v1/plugins/${namespace}/'+d.path,{method:d.method,headers:{'content-type':'application/json'},body:d.body===undefined?undefined:JSON.stringify(d.body)});
            const body=await response.json();frame.contentWindow.postMessage({zelavis:'service-page-response',id:d.id,status:response.status,body},'*');
          });</script>`);
        return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const response = await runtime.fetch(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(["GET", "HEAD"].includes(req.method) ? {} : { body: Buffer.concat(chunks) }) }), { principal: owner });
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) { res.statusCode = 500; res.end(String(error)); }
  });
  let browser;
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}/frame?namespace=stripe`);
      const frame = page.frameLocator("iframe");
      await frame.getByText(/Secret key: (not )?configured/).waitFor();
      await frame.locator("#secret-key").fill("sk_test_browser1234");
      await frame.locator("#webhook-secret").fill("whsec_browser5678");
      const saved = page.waitForResponse(response => response.url().endsWith("/plugins/stripe/settings") && response.request().method() === "PUT");
      await frame.getByRole("button", { name: "Save credentials" }).click();
      const result = await saved; assert.equal(result.status(), 200, await result.text());
      await frame.getByText("Credentials saved.", { exact: true }).waitFor();
      assert.equal(await frame.locator("#secret-key").inputValue(), "");
      assert.equal(await frame.locator("#webhook-secret").inputValue(), "");
      await page.reload();
      await frame.getByText(/Secret key: configured.*1234/).waitFor();
      assert.equal(await frame.locator("#secret-key").inputValue(), "");
      await page.goto(`${base}/frame?namespace=ecommerce`);
      await frame.getByText("Hosted checkout supported", { exact: true }).waitFor();
      await frame.getByText("Failed deliveries retry automatically.", { exact: true }).waitFor();
      await frame.getByText(/hosting: Fulfillment handler failed.*Attempts: 2/).waitFor();
      assert.match(await frame.getByRole("textbox", { name: "stripe webhook address" }).inputValue(), /\/plugins\/ecommerce\/webhooks\/stripe$/);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    if (browser) await browser.close();
    server.close(); await once(server, "close");
    await runtime.close();
  }
});
