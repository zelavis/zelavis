// A loopback XML API fixture for the built-in driver, shared by browser qualification.
import { createServer } from "node:http";
export async function startNamecheapApi() {
  const domains = new Map(), purchases = [], nameservers = new Map();
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
    const command = fields.get("Command") ?? "";
    const domain = fields.get("DomainName");
    const result = body => { response.writeHead(200, { "content-type": "application/xml" }); response.end(`<ApiResponse Status="OK"><Errors/><CommandResponse Type="${command}">${body}</CommandResponse></ApiResponse>`); };
    const fail = number => { response.writeHead(200, { "content-type": "application/xml" }); response.end(`<ApiResponse Status="ERROR"><Errors><Error Number="${number}">Fixture refusal</Error></Errors></ApiResponse>`); };
    if (fields.get("ApiKey") !== "browser-test-key") return fail("1011102");
    if (command === "namecheap.domains.check") return result(fields.get("DomainList").split(",").map(name => `<DomainCheckResult Domain="${name}" Available="${!domains.has(name)}" ErrorNo="0" IsPremiumName="false"/>`).join(""));
    if (command === "namecheap.users.getPricing") return result(`<UserGetPricingResult><ProductType Name="DOMAIN"><ProductCategory Name="${fields.get("ActionName")}"><Product Name="${fields.get("ProductName")}">${Array.from({ length: 10 }, (_, i) => `<Price Duration="${i + 1}" DurationType="YEAR" Price="10" Currency="USD"/>`).join("")}</Product></ProductCategory></ProductType></UserGetPricingResult>`);
    if (command === "namecheap.domains.getInfo") return domains.has(domain) ? result(`<DomainGetInfoResult IsOwner="true"><DomainDetails><ExpiredDate>11/16/${domains.get(domain)}</ExpiredDate></DomainDetails></DomainGetInfoResult>`) : fail("2019166");
    if (command === "namecheap.domains.getList") return result(`<DomainGetListResult>${[...domains].map(([name, year]) => `<Domain Name="${name}" Expires="11/16/${year}"/>`).join("")}</DomainGetListResult><Paging><TotalItems>${domains.size}</TotalItems></Paging>`);
    if (command === "namecheap.domains.create") {
      for (const prefix of ["Registrant", "Tech", "Admin", "AuxBilling"]) if (!fields.get(`${prefix}FirstName`) || !fields.get(`${prefix}EmailAddress`)) return fail("2019165");
      if (domains.has(domain)) return fail("2019166");
      domains.set(domain, 2026 + Number(fields.get("Years"))); purchases.push({ domain, kind: "register" });
      return result(`<DomainCreateResult Registered="true" OrderID="${purchases.length}" ChargedAmount="10"/>`);
    }
    if (command === "namecheap.domains.renew") { if (!domains.has(domain)) return fail("2019166"); domains.set(domain, domains.get(domain) + Number(fields.get("Years"))); purchases.push({ domain, kind: "renew" }); return result(`<DomainRenewResult Renew="true" OrderID="${purchases.length}"/>`); }
    if (command === "namecheap.domains.transfer.create") { purchases.push({ domain, kind: "transfer" }); return result(`<DomainTransferCreateResult Transfer="true" TransferID="${purchases.length}"/>`); }
    if (command === "namecheap.domains.transfer.getStatus") return result('<DomainTransferGetStatusResult StatusID="-1" Status="Queued for submission"/>');
    if (command === "namecheap.domains.dns.setCustom") { nameservers.set(`${fields.get("SLD")}.${fields.get("TLD")}`, fields.get("Nameservers")); return result('<DomainDNSSetCustomResult Updated="true"/>'); }
    return fail("2011010");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { endpoint: `http://127.0.0.1:${server.address().port}/xml.response`, purchases, nameservers, close: () => new Promise(resolve => server.close(resolve)) };
}
