#!/usr/bin/env node
// Sandbox only. No endpoint override and no production credentials or real money.
import { randomUUID } from "node:crypto";
import { namecheapRegistrar } from "../../packages/zelavis/dist/adapters/_registrar-namecheap.js";

const required = ["NAMECHEAP_SANDBOX_API_USER", "NAMECHEAP_SANDBOX_API_KEY", "NAMECHEAP_SANDBOX_CLIENT_IP"];
const missing = required.filter(name => !process.env[name]);
if (missing.length) {
  process.stderr.write(`Missing sandbox inputs: ${missing.join(", ")}\n`);
  process.exitCode = 1;
} else {
  try {
    const client = namecheapRegistrar.createClient({ apiUser: process.env.NAMECHEAP_SANDBOX_API_USER, apiKey: process.env.NAMECHEAP_SANDBOX_API_KEY, userName: process.env.NAMECHEAP_SANDBOX_API_USER, clientIp: process.env.NAMECHEAP_SANDBOX_CLIENT_IP }, { fetch, sandbox: true, signal: AbortSignal.timeout(180_000) });
    const domain = `zelavis-${randomUUID().replaceAll("-", "")}.com`;
    const [available] = await client.check([domain]);
    if (!available.available || !available.price) throw new Error("Sandbox domain is unavailable or unpriced.");
    console.log("PASS check");
    const contact = { firstName: "Zelavis", lastName: "Qualification", address1: "123 Test Street", city: "Los Angeles", stateProvince: "CA", postalCode: "90001", country: "US", phone: "+1.5555550100", email: "qualification@example.com" };
    await client.register({ domain, years: 1, contact, confirm: available.price });
    console.log("PASS register");
    await client.renew({ domain, years: 1, confirm: await client.quote(domain, "renew", 1) });
    console.log("PASS renew");
    let cursor; let found = false;
    for (let page = 0; page < 100; page++) {
      const result = await client.domains({ cursor });
      found ||= result.domains.some(row => row.domain === domain);
      if (found || !result.next) break;
      cursor = result.next;
    }
    if (!found) throw new Error("Sandbox domain was not found in the account inventory.");
    console.log("PASS list");
  } catch (error) {
    // Never print provider bodies, request parameters or credentials.
    process.stderr.write(`FAIL sandbox qualification${typeof error?.number === "string" ? ` (registrar code ${error.number})` : ""}\n`);
    process.exitCode = 1;
  }
}
