// A small ACME v2 server for tests: orders any identifiers, offers http-01 and dns-01 for each, and settles a
// challenge by asking `verify`, which sees the key authorization the client must have published.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { calculateP256JwkThumbprint, fromBase64Url } from "../dist/index.js";

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBkDCB+wIJAL0000000001MAoGCCqGSM49BAMCMBMxETAPBgNVBAMMCFplbGF2\naXMwHhcNMjYwOTIwMDAwMDAwWhcNMjYxMjE5MDAwMDAwWjATMREwDwYDVQQDDAha\nZWxhdmlzMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...\n-----END CERTIFICATE-----";

/**
 * @param {import("node:test").TestContext} t
 * @param {{ verify: (challenge: { type: string, identifier: string, wildcard: boolean, token: string, keyAuthorization: string, dnsValue: string }) => Promise<boolean> | boolean, issue?: (order: { csr: string, identifiers: { value: string }[] }) => string }} options
 */
export async function startAcmeFake(t, { verify, issue }) {
  let thumbprint, nonce = 0, next = 0;
  const orders = new Map(), authorizations = new Map(), certificates = new Map(), notified = [];
  const server = createServer(async (req, res) => {
    const origin = `http://${req.headers.host}`;
    const url = new URL(req.url ?? "/", origin);
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "Replay-Nonce": `nonce-${++nonce}`, "Content-Type": "application/json", ...headers });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (url.pathname === "/directory") return send(200, { newNonce: `${origin}/new-nonce`, newAccount: `${origin}/new-account`, newOrder: `${origin}/new-order` });
    if (url.pathname === "/new-nonce") return send(200, "");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const jws = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const header = jws.protected ? JSON.parse(fromBase64Url(jws.protected).toString("utf8")) : {};
    const payload = jws.payload ? JSON.parse(fromBase64Url(jws.payload).toString("utf8")) : undefined;
    if (url.pathname === "/new-account") {
      thumbprint = calculateP256JwkThumbprint(header.jwk);
      return send(201, { status: "valid" }, { Location: `${origin}/acct/1` });
    }
    if (url.pathname === "/new-order") {
      const id = ++next;
      const order = { status: "pending", identifiers: payload.identifiers, authorizations: [], finalize: `${origin}/finalize/${id}` };
      for (const { value } of payload.identifiers) {
        const authz = `${id}-${order.authorizations.length}`;
        const wildcard = value.startsWith("*.");
        authorizations.set(authz, { status: "pending", identifier: { type: "dns", value: wildcard ? value.slice(2) : value }, wildcard, token: `token-${authz}` });
        order.authorizations.push(`${origin}/authz/${authz}`);
      }
      orders.set(String(id), order);
      return send(201, order, { Location: `${origin}/order/${id}` });
    }
    const [, kind, id] = url.pathname.split("/");
    if (kind === "authz") {
      const authz = authorizations.get(id);
      return send(200, {
        status: authz.status, identifier: authz.identifier, ...(authz.wildcard ? { wildcard: true } : {}),
        challenges: ["http-01", "dns-01"].filter(type => !(authz.wildcard && type === "http-01"))
          .map(type => ({ type, url: `${origin}/chal/${id}/${type}`, token: authz.token, status: authz.status })),
      });
    }
    if (kind === "chal") {
      const authz = authorizations.get(id);
      const type = url.pathname.split("/")[3];
      const keyAuthorization = `${authz.token}.${thumbprint}`;
      const dnsValue = createHash("sha256").update(keyAuthorization).digest("base64url");
      notified.push({ type, identifier: authz.identifier.value, wildcard: authz.wildcard });
      authz.status = (await verify({ type, identifier: authz.identifier.value, wildcard: authz.wildcard, token: authz.token, keyAuthorization, dnsValue })) ? "valid" : "invalid";
      return send(200, { type, url: `${origin}${url.pathname}`, status: authz.status });
    }
    if (kind === "finalize") {
      const order = orders.get(id);
      if (issue) {
        try {
          certificates.set(id, issue({ csr: payload.csr, identifiers: order.identifiers }));
        } catch (error) {
          return send(500, { type: "urn:ietf:params:acme:error:serverInternal", detail: error.message });
        }
      }
      return send(200, { ...order, status: "valid", certificate: `${origin}/cert/${id}` }, { Location: `${origin}/order/${id}` });
    }
    if (kind === "order") return send(200, { ...orders.get(id), status: "valid", certificate: `${origin}/cert/${id}` });
    if (kind === "cert") {
      res.writeHead(200, { "Replay-Nonce": `nonce-${++nonce}`, "Content-Type": "application/pem-certificate-chain" });
      return res.end(certificates.get(id) ?? PEM);
    }
    send(404, { type: "urn:ietf:params:acme:error:malformed" });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { directoryUrl: `http://127.0.0.1:${server.address().port}/directory`, notified, orders };
}
