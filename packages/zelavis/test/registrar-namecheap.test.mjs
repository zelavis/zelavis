import assert from "node:assert/strict";
import test from "node:test";
import { createNamecheapRegistrar } from "../dist/adapters/_registrar-namecheap.js";
import { parseXmlResponse } from "../dist/adapters/_xml-response.js";
const credentials = { apiUser: "user", apiKey: "secret-key", userName: "account", clientIp: "192.0.2.1" };
const envelope = (command, body, status = "OK") => `<?xml version="1.0"?><ApiResponse Status="${status}"><Errors />` + `<CommandResponse Type="${command}">${body}</CommandResponse></ApiResponse>`;
const contact = { firstName: "Test", lastName: "Owner", address1: "1 Test Street", city: "City", stateProvince: "CA", postalCode: "90001", country: "US", phone: "+1.5550100", email: "owner@example.com" };
const confirm = { amount: "10.0000", currency: "USD", years: 1 };
function fixture() {
  const calls = []; let fail; let premium = false; let fee = "0"; let status = "5";
  const client = createNamecheapRegistrar({ endpoint: "http://127.0.0.1:5000/xml.response" }).createClient(credentials, {
    sandbox: true, fetch: async (url, options) => {
      assert.equal(new URL(url).search, ""); assert.equal(options.method, "POST"); assert.equal(options.redirect, "error");
      const p = Object.fromEntries(options.body); calls.push(p);
      for (const [key, value] of Object.entries({ ApiUser: "user", ApiKey: "secret-key", UserName: "account", ClientIp: "192.0.2.1" })) assert.equal(p[key], value);
      if (fail) return new Response(fail);
      const c = p.Command; let body;
      if (c.endsWith("domains.check")) body = p.DomainList.split(",").map(domain => `<DomainCheckResult Domain="${domain}" Available="true" ErrorNo="0" IsPremiumName="${premium}" PremiumRegistrationPrice="100" PremiumRenewalPrice="20" IcannFee="${fee}" EapFee="0"/>`).join("");
      else if (c.endsWith("getPricing")) body = `<UserGetPricingResult><ProductType Name="DOMAIN"><ProductCategory Name="${p.ActionName}"><Product Name="${p.ProductName}"><Price Duration="${p.Years ?? 1}" DurationType="YEAR" Price="10" YourPrice="9" Currency="USD"/><Price Duration="2" DurationType="YEAR" Price="9" Currency="USD"/></Product></ProductCategory></ProductType></UserGetPricingResult>`;
      else if (c.endsWith("domains.create")) body = '<DomainCreateResult Registered="true" OrderID="o1" ChargedAmount="10.00"/>';
      else if (c.endsWith("domains.renew")) body = '<DomainRenewResult Renew="true" OrderID="o2"/>';
      else if (c.endsWith("transfer.create")) body = '<DomainTransferCreateResult Transfer="true" TransferID="t1"/>';
      else if (c.endsWith("transfer.getStatus")) body = `<DomainTransferGetStatusResult TransferID="t1" Status="Test" StatusID="${status}"/>`;
      else if (c.endsWith("getInfo")) body = '<DomainGetInfoResult IsOwner="true"><DomainDetails><ExpiredDate>11/16/2027</ExpiredDate></DomainDetails></DomainGetInfoResult>';
      else if (c.endsWith("getList")) body = '<DomainGetListResult><Domain Name="example.com" Expires="11/16/2027"/></DomainGetListResult><Paging><TotalItems>51</TotalItems></Paging>';
      else if (c.endsWith("setCustom")) body = '<DomainDNSSetCustomResult Updated="true"/>';
      else throw new Error(c);
      return new Response(envelope(c, body));
    },
  });
  return { client, calls, fail: value => { fail = value; }, premium: () => { premium = true; }, fee: value => { fee = value; }, status: value => { status = value; } };
}
test("bounded XML parser accepts five entities and refuses expansion, malformed structure and duplicate attributes", () => {
  assert.equal(parseXmlResponse('<A x="&quot;&apos;&amp;&lt;&gt;">ok</A>').attributes.x, '"\'&<>');
  for (const raw of ['<!DOCTYPE A><A/>', '<A>&#65;</A>', '<A>&bad;</A>', '<A x="1" x="2"/>', '<A><B></A>', '<'.repeat(100_000), '<A/><B/>', '<A>bad<', '<A>'+"x".repeat(1_048_576)+'</A>', '<A>'.repeat(33)+'</A>'.repeat(33)]) assert.throws(() => parseXmlResponse(raw));
});
test("Namecheap driver uses documented commands, POST fields, total prices and explicit success flags", async () => {
  const { client, calls, status } = fixture();
  assert.deepEqual(await client.check(["example.com"]), [{ domain: "example.com", available: true, premium: false, price: confirm }]);
  assert.deepEqual(await client.price("com", "register", 2), { amount: "18.0000", currency: "USD", years: 2 });
  assert.equal((await client.register({ domain: "example.com", years: 1, contact, confirm })).registrarOrderId, "o1");
  const create = calls.find(p => p.Command.endsWith("domains.create"));
  for (const prefix of ["Registrant", "Tech", "Admin", "AuxBilling"]) { assert.equal(create[`${prefix}FirstName`], "Test"); assert.equal(create[`${prefix}EmailAddress`], contact.email); }
  assert.equal((await client.renew({ domain: "example.com", years: 1, confirm })).registrarOrderId, "o2");
  assert.equal((await client.transfer({ domain: "example.com", years: 1, authCode: "a&<code>", confirm })).transferId, "t1");
  assert.equal(calls.find(p => p.Command.endsWith("transfer.create")).EPPCode, `base64:${Buffer.from("a&<code>").toString("base64")}`);
  assert.equal((await client.transferStatus("t1")).state, "completed"); status("-1"); assert.equal((await client.transferStatus("t1")).state, "pending"); status("32"); assert.equal((await client.transferStatus("t1")).state, "failed");
  assert.deepEqual(await client.domain("example.com"), { owned: true, expiresAt: "2027-11-16T00:00:00.000Z" });
  assert.equal((await client.domains({})).next, "2");
  await client.setNameservers("example.co.uk", ["ns1.example.com", "ns2.example.com"]);
  assert.equal(calls.at(-1).TLD, "co.uk"); assert.equal(calls.at(-1).Nameservers, "ns1.example.com,ns2.example.com");
  await assert.rejects(client.transfer({ domain: "example.com", years: 2, authCode: "secret", confirm }), /exactly one year/);
});
test("premium price is domain-specific; API error text never leaks secrets or contact data", async () => {
  const f = fixture(); f.premium();
  assert.equal((await f.client.check(["example.com"]))[0].price.amount, "100.0000");
  await f.client.register({ domain: "example.com", years: 1, contact, confirm: { ...confirm, amount: "100.0000" } });
  assert.equal(f.calls.at(-1).PremiumPrice, "100");
  f.fail('<ApiResponse Status="ERROR"><Errors><Error Number="2016166">secret-key owner@example.com</Error></Errors></ApiResponse>');
  await assert.rejects(f.client.check(["example.com"]), e => e.number === "2016166" && !e.message.includes("secret-key") && !e.message.includes(contact.email));
  f.fail('<ApiResponse Status="ERROR"><Errors><Error Number="secret-key">secret-key</Error></Errors></ApiResponse>');
  await assert.rejects(f.client.check(["example.com"]), e => e.number === undefined && !e.message.includes("secret-key"));
  f.fail('<!DOCTYPE x><ApiResponse/>'); await assert.rejects(f.client.check(["example.com"]), /malformed XML/);
});

test("pricing accepts the sandbox's lowercase category and the documented uppercase category", async () => {
  const f = fixture();
  for (const category of ["register", "REGISTER"]) {
    f.fail(envelope("namecheap.users.getPricing", `<UserGetPricingResult><ProductType Name="domains"><ProductCategory Name="${category}"><Product Name="com"><Price Duration="1" DurationType="YEAR" Price="15.98" YourPrice="15.98" Currency="USD"/></Product></ProductCategory></ProductType></UserGetPricingResult>`));
    assert.deepEqual(await f.client.price("com", "register", 1), { amount: "15.9800", currency: "USD", years: 1 });
  }
});

 test("quotes include returned ICANN fees using exact decimal totals", async () => {
  const f = fixture(); f.fee("0.2000");
  assert.deepEqual(await f.client.quote("example.com", "register", 2), { amount: "18.4000", currency: "USD", years: 2 });
});

test("availability batches reuse their check results and one price per TLD without caching a purchase quote", async () => {
  const f = fixture();
  assert.equal((await f.client.check(["one.com", "two.com"])).length, 2);
  assert.deepEqual(f.calls.map(row => row.Command), ["namecheap.domains.check", "namecheap.users.getPricing"]);
  await f.client.quote("one.com", "register", 1);
  assert.equal(f.calls.filter(row => row.Command === "namecheap.users.getPricing").length, 2);
});
