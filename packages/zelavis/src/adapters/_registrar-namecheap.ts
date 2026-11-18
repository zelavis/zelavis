/** Namecheap XML API. All parameters, including credentials and contacts, travel in a POST body. */
import { Data, Effect } from "effect";
import { evaluate, present } from "../core/runtime/effect-boundary.js";
import type { RegistrarAction, RegistrarClient, RegistrarContact, RegistrarDefinition, RegistrarPrice } from "../edge/registrar-provider.js";
import { parseXmlResponse, xmlChild, type XmlElement } from "./_xml-response.js";

export class NamecheapRegistrarError extends Data.TaggedError("NamecheapRegistrarError")<{
  readonly message: string; readonly number?: string; readonly definite: boolean;
}> {}
const error = (message: string, definite = false, number?: string) => new NamecheapRegistrarError({ message, definite, ...(number ? { number } : {}) });
const money = (value: string) => {
  if (!/^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,4})?$/u.test(value)) throw error("Namecheap returned an invalid price.");
  const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * BigInt(10_000) + BigInt(fraction.padEnd(4, "0"));
};
const decimal = (units: bigint) => `${units / BigInt(10_000)}.${String(units % BigInt(10_000)).padStart(4, "0")}`;
const truth = (value?: string) => { if (!/^(true|false)$/iu.test(value ?? "")) throw error("Namecheap returned an invalid flag."); return value!.toLowerCase() === "true"; };
const attr = (element: XmlElement, name: string) => { const value = element.attributes[name]; if (!value) throw error("Namecheap's answer is incomplete."); return value; };
const date = (raw: string): string => {
  // Namecheap documents US month/day/year, sometimes with a 12-hour time; expiry reconciliation needs a stable UTC date.
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+\d{1,2}:\d{2}:\d{2}\s+[AP]M)?$/iu.exec(raw);
  if (!match) throw error("Namecheap returned an invalid expiry date.");
  const result = new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
  if (result.getUTCMonth() !== Number(match[1]) - 1 || result.getUTCDate() !== Number(match[2])) throw error("Namecheap returned an invalid expiry date.");
  return result.toISOString();
};
const domainParts = (domain: string) => { const dot = domain.indexOf("."); if (dot < 1 || domain.length > 70) throw error("The domain name is invalid.", true); return { SLD: domain.slice(0, dot), TLD: domain.slice(dot + 1) }; };
const contactFields: Readonly<Record<keyof RegistrarContact, string>> = { firstName: "FirstName", lastName: "LastName", organization: "OrganizationName", address1: "Address1", address2: "Address2", city: "City", stateProvince: "StateProvince", postalCode: "PostalCode", country: "Country", phone: "Phone", email: "EmailAddress" };

export function createNamecheapRegistrar(options: { readonly endpoint?: string } = {}): RegistrarDefinition {
  if (options.endpoint) {
    const url = new URL(options.endpoint);
    if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))) throw new TypeError("A registrar test endpoint must be HTTPS or loopback HTTP.");
  }
  return {
    name: "namecheap", title: "Namecheap",
    credentials: [{ name: "apiUser", label: "API user", secret: false }, { name: "apiKey", label: "API key", secret: true }, { name: "userName", label: "Account username", secret: false }, { name: "clientIp", label: "Whitelisted client IPv4", secret: false }],
    tokenGuidance: "Enable API access and whitelist this server's outgoing IPv4 in your Namecheap account. The key can spend the account balance and manage its domains. Use a dedicated account. Sandbox credentials belong to a separate sandbox account.",
    createClient(credentials, context): RegistrarClient {
      const endpoint = options.endpoint ?? (context.sandbox ? "https://api.sandbox.namecheap.com/xml.response" : "https://api.namecheap.com/xml.response");
      const request = Effect.fn("Namecheap.request")(function* (command: string, parameters: Record<string, string>) {
        const body = new URLSearchParams({ ApiUser: credentials.apiUser ?? "", ApiKey: credentials.apiKey ?? "", UserName: credentials.userName ?? "", ClientIp: credentials.clientIp ?? "", Command: `namecheap.${command}`, ...parameters });
        const response = yield* Effect.tryPromise({ try: () => context.fetch(endpoint, { method: "POST", body, headers: { accept: "application/xml" }, redirect: "error", ...(context.signal ? { signal: context.signal } : {}) }), catch: () => error("Namecheap could not be reached; check the order before retrying.") });
        if (!response.body) return yield* error("Namecheap returned no body.");
        const reader = response.body.getReader();
        const raw = yield* Effect.gen(function* () {
          const chunks: Uint8Array[] = []; let bytes = 0;
          for (;;) {
            const chunk = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => error("Namecheap's answer was interrupted.") });
            if (chunk.done) break;
            bytes += chunk.value.length;
            if (bytes > 1_048_576) return yield* error("Namecheap's answer is too large.");
            chunks.push(chunk.value);
          }
          const all = new Uint8Array(bytes); let offset = 0;
          for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
          return new TextDecoder("utf-8", { fatal: true }).decode(all);
        }).pipe(Effect.ensuring(Effect.tryPromise({ try: () => reader.cancel(), catch: () => error("Namecheap's response could not be closed.") }).pipe(Effect.catch(() => Effect.logWarning("registrar.response-close-failed")))));
        const root = yield* evaluate(() => parseXmlResponse(raw)).pipe(Effect.mapError(() => error("Namecheap returned malformed XML.")));
        if (root.name !== "ApiResponse" || !["OK", "ERROR"].includes(root.attributes.Status ?? "")) return yield* error("Namecheap returned an invalid envelope.");
        if (root.attributes.Status === "ERROR") {
          const errors = xmlChild(root, "Errors").children;
          const rawNumber = errors[0]?.attributes.Number;
          const number = rawNumber && /^[0-9]{1,10}$/u.test(rawNumber) ? rawNumber : undefined;
          // Provider messages may echo a key, an EPP code or contact data. Retain the code; expose fixed wording only.
          return yield* error("Namecheap refused the request. Check the registrar account for details.", Boolean(number && /^(?:20|25)/u.test(number)), number);
        }
        if (!response.ok) return yield* error("Namecheap answered with an HTTP failure.");
        const answer = yield* evaluate(() => xmlChild(root, "CommandResponse")).pipe(Effect.mapError(() => error("Namecheap's answer is incomplete.")));
        if (answer.attributes.Type?.toLowerCase() !== `namecheap.${command}`.toLowerCase()) return yield* error("Namecheap answered another command.");
        return answer;
      });
      const checked = Effect.fn("Namecheap.check")(function* (domains: readonly string[]) {
        const answer = yield* request("domains.check", { DomainList: domains.join(",") });
        return yield* evaluate(() => {
          const results = answer.children.filter(row => row.name === "DomainCheckResult");
          if (results.length !== domains.length || new Set(results.map(row => row.attributes.Domain)).size !== domains.length) throw error("Namecheap returned an incomplete availability answer.");
          return domains.map(domain => {
            const row = results.find(row => row.attributes.Domain?.toLowerCase() === domain); if (!row || attr(row, "ErrorNo") !== "0") throw error("Namecheap could not check the domain.");
            return row;
          });
        }).pipe(Effect.mapError(() => error("Namecheap could not check the domains.")));
      });
      const pricing = Effect.fn("Namecheap.price")(function* (tld: string, action: RegistrarAction, years: number) {
        if (action === "transfer" && years !== 1) return yield* error("Namecheap transfers add exactly one year.", true);
        const answer = yield* request("users.getPricing", { ProductType: "DOMAIN", ProductCategory: "DOMAINS", ActionName: action.toUpperCase(), ProductName: tld });
        return yield* evaluate(() => {
          const type = xmlChild(xmlChild(answer, "UserGetPricingResult"), "ProductType");
          const category = type.children.find(row => row.name === "ProductCategory" && row.attributes.Name?.toLowerCase() === action);
          const product = category?.children.find(row => row.attributes.Name?.toLowerCase() === tld.toLowerCase());
          const row = product?.children.find(row => row.attributes.Duration === String(years) && row.attributes.DurationType === "YEAR");
          if (!row) throw error("Namecheap does not offer this duration.", true);
          // Duration rows are per-year prices; the public contract always returns the total.
          return { amount: decimal(money(attr(row, "Price")) * BigInt(years)), currency: attr(row, "Currency"), years };
        });
      });
      const quoted = Effect.fn("Namecheap.quoted")(function* (domain: string, action: RegistrarAction, years: number, known?: XmlElement) {
        const row = known ?? (yield* checked([domain]))[0]!;
        if (truth(row.attributes.IsPremiumName)) {
          if (years !== 1 || action === "transfer") return yield* error("This premium operation is not supported by Namecheap.", true);
          const amount = money(attr(row, action === "renew" ? "PremiumRenewalPrice" : "PremiumRegistrationPrice"));
          const fees = money(row.attributes.IcannFee ?? "0") + (action === "register" ? money(row.attributes.EapFee ?? "0") : BigInt(0));
          if (action === "register" && money(row.attributes.EapFee ?? "0") > BigInt(0)) return yield* error("Namecheap does not support premium EAP registration through its API.", true);
          return { price: { amount: decimal(amount + fees), currency: "USD", years }, row };
        }
        const base = yield* pricing(domainParts(domain).TLD, action, years);
        return { price: { ...base, amount: decimal(money(base.amount) + money(row.attributes.IcannFee ?? "0") * BigInt(years)) }, row };
      });
      const quote = (domain: string, action: RegistrarAction, years: number) => quoted(domain, action, years).pipe(Effect.map(result => result.price));
      const premiumParameters = Effect.fn("Namecheap.premiumParameters")(function* (domain: string, action: RegistrarAction, confirm: RegistrarPrice) {
        const { price: current, row } = yield* quoted(domain, action, confirm.years);
        if (money(current.amount) !== money(confirm.amount) || current.currency !== confirm.currency) return yield* error("The registrar price changed before submission.", true);
        return truth(row.attributes.IsPremiumName) ? { IsPremiumDomain: "true", PremiumPrice: attr(row, action === "renew" ? "PremiumRenewalPrice" : "PremiumRegistrationPrice"), ...(action === "register" ? { EapFee: row.attributes.EapFee ?? "0" } : {}) } : { IsPremiumDomain: "false" };
      });
      return {
        check: domains => present(Effect.gen(function* () {
          const rows = yield* checked(domains);
          // Cache only within this availability batch. Purchase quotes always read fresh registrar pricing.
          const quotes = new Map<string, RegistrarPrice>();
          return yield* Effect.forEach(rows, (row, index) => Effect.gen(function* () {
            const available = yield* evaluate(() => truth(row.attributes.Available));
            const premium = yield* evaluate(() => truth(row.attributes.IsPremiumName));
            let price: RegistrarPrice | undefined;
            if (available) {
              const key = `${domainParts(domains[index]!).TLD}:${row.attributes.IcannFee ?? "0"}`;
              price = premium ? undefined : quotes.get(key);
              if (!price) {
                price = (yield* quoted(domains[index]!, "register", 1, row)).price;
                if (!premium) quotes.set(key, price);
              }
            }
            return { domain: domains[index]!, available, premium, ...(price ? { price } : {}) };
          }), { concurrency: 1 });
        })),
        price: (tld, action, years) => present(pricing(tld, action, years)),
        quote: (domain, action, years) => present(quote(domain, action, years)),
        register: input => present(Effect.gen(function* () {
          const parameters: Record<string, string> = { DomainName: input.domain, Years: String(input.years), ...yield* premiumParameters(input.domain, "register", input.confirm), ...(input.nameservers ? { Nameservers: input.nameservers.join(",") } : {}) };
          for (const prefix of ["Registrant", "Tech", "Admin", "AuxBilling"]) for (const [key, suffix] of Object.entries(contactFields)) {
            const value = input.contact[key as keyof RegistrarContact]; if (value !== undefined) parameters[`${prefix}${suffix}`] = value;
          }
          const row = xmlChild(yield* request("domains.create", parameters), "DomainCreateResult");
          if (!truth(row.attributes.Registered)) return yield* error("Namecheap did not confirm registration.");
          return { registrarOrderId: attr(row, "OrderID"), ...(row.attributes.ChargedAmount ? { chargedAmount: row.attributes.ChargedAmount } : {}) };
        })),
        renew: input => present(Effect.gen(function* () {
          const row = xmlChild(yield* request("domains.renew", { DomainName: input.domain, Years: String(input.years), ...yield* premiumParameters(input.domain, "renew", input.confirm) }), "DomainRenewResult");
          if (!truth(row.attributes.Renew)) return yield* error("Namecheap did not confirm renewal.");
          return { registrarOrderId: attr(row, "OrderID") };
        })),
        transfer: input => present(Effect.gen(function* () {
          if (input.years !== 1) return yield* error("Namecheap transfers add exactly one year.", true);
          const current = yield* quote(input.domain, "transfer", 1);
          if (money(current.amount) !== money(input.confirm.amount) || current.currency !== input.confirm.currency) return yield* error("The registrar price changed before submission.", true);
          const row = xmlChild(yield* request("domains.transfer.create", { DomainName: input.domain, Years: "1", EPPCode: `base64:${Buffer.from(input.authCode, "utf8").toString("base64")}` }), "DomainTransferCreateResult");
          if (!truth(row.attributes.Transfer)) return yield* error("Namecheap did not confirm the transfer.");
          return { transferId: attr(row, "TransferID") };
        })),
        transferStatus: transferId => present(Effect.gen(function* () {
          const row = xmlChild(yield* request("domains.transfer.getStatus", { TransferID: transferId }), "DomainTransferGetStatusResult");
          const status = attr(row, "Status").toUpperCase(); const id = Number(attr(row, "StatusID"));
          const completed = status === "COMPLETED" || id === 5;
          const failed = status === "CANCELED" || [2, 4, 6, 8, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 33, 34, 36, 37, 45, 48, 49, 50, 51, -4].includes(id);
          return { state: completed ? "completed" as const : failed ? "failed" as const : "pending" as const };
        })),
        domain: domain => present(Effect.gen(function* () {
          const result = yield* Effect.result(request("domains.getInfo", { DomainName: domain }));
          if (result._tag === "Failure") {
            // Only these documented absence/foreign-account errors mean not owned. Auth/network errors stay errors.
            if (result.failure instanceof NamecheapRegistrarError && ["2019166", "2016166"].includes(result.failure.number ?? "")) return { owned: false };
            return yield* Effect.fail(result.failure);
          }
          const row = xmlChild(result.success, "DomainGetInfoResult");
          const owned = truth(row.attributes.IsOwner);
          const details = row.children.find(child => child.name === "DomainDetails");
          const expiry = details?.children.find(child => child.name === "ExpiredDate")?.text.trim();
          return { owned, ...(expiry ? { expiresAt: date(expiry) } : {}) };
        })),
        domains: ({ cursor }) => present(Effect.gen(function* () {
          const page = cursor === undefined ? 1 : Number(cursor);
          if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) return yield* error("The registrar page is invalid.", true);
          const answer = yield* request("domains.getList", { Page: String(page), PageSize: "50" });
          const rows = xmlChild(answer, "DomainGetListResult").children;
          const total = Number(xmlChild(xmlChild(answer, "Paging"), "TotalItems").text);
          if (!Number.isSafeInteger(total) || total < 0 || rows.length > 50) return yield* error("Namecheap returned invalid paging.");
          return { domains: rows.map(row => ({ domain: attr(row, "Name"), ...(row.attributes.Expires ? { expiresAt: date(row.attributes.Expires) } : {}) })), ...(page * 50 < total ? { next: String(page + 1) } : {}) };
        })),
        setNameservers: (domain, nameservers) => present(Effect.gen(function* () {
          const row = xmlChild(yield* request("domains.dns.setCustom", { ...domainParts(domain), Nameservers: nameservers.join(",") }), "DomainDNSSetCustomResult");
          if (!truth(row.attributes.Updated)) return yield* error("Namecheap did not confirm the nameserver update.");
        })),
      };
    },
  };
}
export const namecheapRegistrar = createNamecheapRegistrar();
