#!/usr/bin/env node
// Qualifying domains: build the checkout, then run pnpm release:qualify:domains --self-test (loopback, OpenSSL).
// For a public run set ZELAVIS_QUALIFY_DOMAINS_{SSH,ZONE,CLOUDFLARE_TOKEN,IPV6,IFACE}.
// The Cloudflare token needs Zone read and DNS edit on the qualification zone.
// Use root SSH to a disposable Linux environment with systemd, nftables, an unused routed IPv6 address
// and inbound HTTP/HTTPS. SSH_KEY is optional. RECURSIVE_IPV4 defaults to 1.1.1.1;
// choose a public recursive resolver that retains the seeded negative answer.
// The client needs IPv6 and UDP access to that resolver on port 53.
// ZELAVIS_QUALIFY_KEEP=1 preserves failed-run files for inspection after listeners and DNS are cleaned up.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomInt, X509Certificate } from "node:crypto";
import { createSocket } from "node:dgram";
import { Resolver } from "node:dns/promises";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer, request as httpsRequest } from "node:https";
import { createServer as netServer, isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createSecureContext } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), "../..");
const stagingDirectory = "https://acme-staging-v02.api.letsencrypt.org/directory";
// https://letsencrypt.org/docs/staging-environment/#root-cas
const stagingRoots = ["letsencrypt-stg-root-x1.pem", "letsencrypt-stg-root-x2.pem", "gen-y/root-ye.pem", "gen-y/root-yr.pem"];
const mount = "/zelavis/api/v1";
const probePath = "/.well-known/zelavis-project-domain";
const prefix = "ZELAVIS_QUALIFY_DOMAINS_";
const commandEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== prefix + "CLOUDFLARE_TOKEN"));
const domainTypes = ["A", "AAAA", "CNAME", "TXT"];
const projectId = "domains-lab";
const jsonHeaders = { "content-type": "application/json" };
const failures = [];
const operationSignal = new AbortController();

function fail(leg, error) {
  const message = error instanceof Error ? error.message : String(error);
  const token = process.env[prefix + "CLOUDFLARE_TOKEN"];
  failures.push(leg);
  console.error(`FAIL ${leg}: ${token ? message.replaceAll(token, "[token]") : message}`);
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    env: commandEnv, encoding: "utf8", timeout: 120_000, maxBuffer: 2 * 1024 * 1024, ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${binary} failed (${result.error?.code ?? result.signal ?? result.status})\n${result.stderr ?? ""}${result.stdout ?? ""}`.trim());
  }
  return result.stdout.trim();
}

function timeout(ms, cleanup = false) {
  const deadline = AbortSignal.timeout(ms);
  return cleanup ? deadline : AbortSignal.any([deadline, operationSignal.signal]);
}

async function until(label, ms, poll, read, signal = operationSignal.signal) {
  const deadline = Date.now() + ms;
  do {
    signal.throwIfAborted();
    const value = await read();
    if (value) return value;
    await delay(Math.min(poll, Math.max(0, deadline - Date.now())), undefined, { signal });
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

function resources() {
  const closers = [];
  return {
    after: close => closers.push(close),
    async close() {
      const errors = [];
      for (const close of closers.splice(0).reverse()) {
        try { await close(); }
        catch (error) { errors.push(error.message); }
      }
      if (errors.length) throw new Error(errors.join("\n"));
    },
  };
}

async function listen(scope, server, host = "127.0.0.1") {
  server.listen(0, host);
  await once(server, "listening");
  scope.after(() => new Promise((resolveClose, reject) => {
    server.close(error => error ? reject(error) : resolveClose());
    server.closeAllConnections?.();
  }));
  return server.address().port;
}

function distAt(packageRoot) {
  return path => import(pathToFileURL(join(packageRoot, "dist", path)));
}

function dnsQuery(codec, { host, port }, name, type, recursive) {
  const id = randomInt(65536);
  const question = { name, type };
  const signal = timeout(5_000);
  signal.throwIfAborted();
  return new Promise((resolveQuery, reject) => {
    const socket = createSocket("udp4");
    let settled = false;
    function finish(error, reply) {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      socket.close();
      if (error) reject(error);
      else resolveQuery(reply);
    }
    const abort = () => finish(new Error(`DNS query timed out for ${name} at ${host}.`));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", finish);
    socket.on("message", bytes => {
      try {
        const reply = codec.decodeDnsMessage(bytes);
        const [answered] = reply.questions;
        if (reply.id === id && reply.response && answered?.name === name && answered?.type === type) {
          assert.ok(!reply.truncated, "Qualification DNS reply was truncated");
          finish(undefined, reply);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.connect(port, host, () => socket.send(codec.encodeDnsQuery(id, question, recursive)));
  });
}

function httpsProof({ host, port = 443, ca }, hostname, path, { body, rejectUnauthorized = true, signal = timeout(30_000) } = {}) {
  return new Promise((resolveRequest, reject) => {
    const request = httpsRequest({
      host, port, path, ca, agent: false, servername: hostname, rejectUnauthorized, signal,
      method: body === undefined ? "GET" : "POST",
      headers: { host: hostname, ...(body === undefined ? {} : { ...jsonHeaders, origin: `https://${hostname}` }) },
    }, response => {
      const certificate = response.socket.getPeerCertificate();
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolveRequest({
        status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString(), certificate,
      }));
    });
    request.once("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function proxySite(origin, hostnames, isRouted = () => true) {
  return (request, response) => {
    const host = request.headers.host;
    if (!hostnames.includes(host) || !isRouted(host, request)) {
      response.writeHead(404).end();
      return;
    }
    const upstream = httpRequest(new URL(origin), {
      path: request.url, method: request.method,
      headers: {
        ...request.headers,
        "x-forwarded-proto": request.socket.encrypted ? "https" : (request.headers["x-forwarded-proto"] === "https" ? "https" : "http"),
      },
    }, received => {
      response.writeHead(received.statusCode, received.headers);
      received.once("error", error => response.destroy(error));
      received.pipe(response);
    });
    upstream.once("error", error => response.headersSent ? response.destroy(error) : response.writeHead(502).end());
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  };
}

async function startPlatform(scope, config, dist, edgeFixture) {
  const [{ Zelavis, defineAdapter, createZelavisCertificateController, createZelavisEdgeManager, createZelavisEdgeRouteStore,
    createTraefikEdgeAdapter, createTraefikCertificateDistributor },
  { nodeAdapter, createCloudflareDnsProvider }, { createNodeServer }, { ensureProductionEdge },
  { present }, { loadPlatformMasterSecret }, { toPublicationSummary }, { fetchNodeSite }] = await Promise.all([
    dist("index.js"), dist("adapters/node.js"), dist("runtimes/node.js"), dist("edge/production.js"),
    dist("core/runtime/effect-boundary.js"), dist("platform/master-secret.js"), dist("edge/routes.js"), dist("adapters/_node-site-fetch.js"),
  ]);
  const { work, directoryUrl, bootstrapToken, hostnames, apiBase, dns, connect } = config;
  const baseDir = join(work, "edge-state");
  let routes, manager;
  const recordIntents = join(work, "dns-intents.jsonl");
  await writeFile(recordIntents, "", { mode: 0o600 });
  const provider = createCloudflareDnsProvider({ apiBase });
  const trackedProvider = {
    ...provider,
    createClient(credentials, context) {
      const client = provider.createClient(credentials, context);
      return {
        zones: client.zones, records: client.records, remove: client.remove,
        async create(zone, record) {
          // Save the value before POST so an ambiguous write can be recovered without touching another ACME order.
          await appendFile(recordIntents, JSON.stringify(record) + "\n");
          const created = await client.create(zone, record);
          await appendFile(recordIntents, JSON.stringify(created) + "\n");
          return created;
        },
      };
    },
  };
  const node = nodeAdapter({ dataDirectory: join(work, "data"), terminal: false, edge: false, projects: { previewHost: false } });
  const adapter = defineAdapter({
    name: node.name,
    close: node.close,
    async resolve(options) {
      const resolved = await node.resolve(options);
      const store = resolved.resources.systemStore;
      const masterSecret = await loadPlatformMasterSecret(store);
      routes = createZelavisEdgeRouteStore({ store });
      const certificates = createZelavisCertificateController({ store, masterSecret, defaultDirectoryUrl: directoryUrl });
      const certificateResolver = ref => certificates.resolveCertificate(ref);
      const invoker = edgeFixture?.invoker ?? {
        async execute(operation, args) {
          if (operation === "zelavis.edge-unit-control") return { active: true, status: "active" };
          if (operation === "zelavis.edge-stage" && args["cert-name"]) {
            // Keep certificate keys out of process arguments. These files are owned by the disposable user.
            const certs = join(baseDir, "certs");
            await mkdir(certs, { recursive: true, mode: 0o700 });
            await writeFile(join(certs, args["cert-name"] + ".crt"), args["cert-pem"], { mode: 0o600 });
            await writeFile(join(certs, args["cert-name"] + ".key"), args["key-pem"], { mode: 0o600 });
            return {};
          }
          const artifact = join(config.packageRoot, "dist/installation-assets/operations", operation, "v1/artifact");
          const flags = Object.entries(args).flatMap(([name, value]) => [`--${name}`, value]);
          return JSON.parse(command("/bin/sh", [artifact, ...flags]) || "{}");
        },
      };
      manager = createZelavisEdgeManager({
        store, defaultAdapterId: "traefik",
        adapters: [createTraefikEdgeAdapter({ invoker, routeStore: routes, baseDir, drainDurationMs: 0 })],
        certificates: createTraefikCertificateDistributor({ invoker, baseDir, certificateResolver }),
        async getPublication() {
          const publication = await routes.getCurrentPublication();
          return publication && toPublicationSummary(publication);
        },
      });
      const probeHttp = async hostname => {
        const reply = await fetchNodeSite(new URL(`http://${connect.http}${probePath}`), {
          method: "GET", headers: { host: hostname }, signal: AbortSignal.timeout(2_500),
        });
        await reply.body?.cancel();
        return reply.status === 204 && reply.headers.get("x-zelavis-project-domain") === "ready";
      };
      return {
        ...resolved,
        resources: {
          ...resolved.resources, edge: manager, edgeRoutes: routes, edgeCertificates: certificates,
          edgeDnsProviders: [trackedProvider],
          ...(dns ? { edgeAuthoritativeTxt: dns } : {}),
          projectDomainIngress: {
            ...resolved.resources.projectDomainIngress,
            ...(dns ? { dns } : {}),
            async preflight(hostname) {
              if (!dns) {
                const resolver = new Resolver({ timeout: 2_000, tries: 1 });
                if (!(await resolver.resolve6(hostname)).some(address => normalizeIpv6(address) === normalizeIpv6(connect.host))) return false;
              }
              return probeHttp(hostname);
            },
            async probe(hostname) {
              const response = await httpsProof(connect, hostname, probePath, { signal: AbortSignal.timeout(2_500) });
              return response.status === 204 && response.headers["x-zelavis-project-domain"] === "ready";
            },
            async probeWithdrawal(hostname) {
              // The HTTP fallback stays available for the pre-activation ACME challenge. Withdrawal is proved on TLS.
              const response = await httpsProof(connect, hostname, probePath, { rejectUnauthorized: false, signal: AbortSignal.timeout(2_500) });
              return response.status === 404 && !response.headers["x-zelavis-project-domain"];
            },
          },
        },
      };
    },
  });

  process.env.ZELAVIS_BOOTSTRAP_TOKEN = bootstrapToken;
  const platform = new Zelavis({ adapter });
  scope.after(() => platform.close());
  const managementPort = await listen(scope, await createNodeServer(platform));
  const origin = `http://127.0.0.1:${managementPort}`;
  const forward = proxySite(origin, hostnames);
  const publicPort = await listen(scope, httpServer((request, response) => {
    if (!hostnames.includes(request.headers.host)) return response.writeHead(404).end();
    routes.getHostname(request.headers.host).then(row => {
      // An unclaimed or withdrawn test hostname must never reach the Platform fallback.
      if (row?.projectDomain) forward(request, response);
      else response.writeHead(404).end();
    }, () => response.writeHead(503).end());
  }));
  await edgeFixture?.start(`http://127.0.0.1:${publicPort}`, hostnames);
  await present(ensureProductionEdge({ routes, manager, port: publicPort }));
  return { origin, recordIntents };
}

function localEdge(scope, ca, key) {
  let staged, active;
  const certificates = new Map();
  const connect = { host: "127.0.0.1", ca };
  return {
    connect,
    invoker: {
      async execute(operation, args) {
        switch (operation) {
          case "zelavis.edge-unit-control": return { active: true, status: "active" };
          case "zelavis.edge-stage":
            if (args["cert-name"]) certificates.set(args["cert-name"], {
              cert: args["cert-pem"], key: args["key-pem"],
            });
            else if (args["config-json"]) staged = JSON.parse(args["config-json"]);
            return {};
          case "zelavis.edge-validate": return { valid: Boolean(staged) };
          case "zelavis.edge-activate": active = staged; return { status: "activated" };
          case "zelavis.edge-drain": return {};
          default: throw new Error(`Unexpected fixture Edge operation ${operation}.`);
        }
      },
    },
    async start(origin, hostnames) {
      const plain = await listen(scope, httpServer(proxySite(origin, hostnames)));
      connect.http = `127.0.0.1:${plain}`;
      const entryFor = hostname => {
        for (const { certFile } of active?.tls?.certificates ?? []) {
          const entry = certificates.get(certFile.split("/").pop().replace(/\.crt$/u, ""));
          if (entry && new X509Certificate(entry.cert).checkHost(hostname)) return entry;
        }
      };
      connect.port = await listen(scope, httpsServer({
        cert: ca, key,
        SNICallback(hostname, callback) {
          const entry = entryFor(hostname);
          callback(null, entry && createSecureContext(entry));
        },
      }, proxySite(origin, hostnames, hostname => Boolean(entryFor(hostname)))));
    },
  };
}

async function selfTest(scope, config, dist) {
  const [{ startDnsAuthority }, { startAcmeFake }, { startFakeCloudflare }, { createAuthoritativeDnsTxtResolver }, codec, { fetchNodeSite }] =
    await Promise.all([
      import("../../packages/zelavis/test/_dns-authority.mjs"), import("../../packages/zelavis/test/_acme-fake.mjs"),
      import("./domains/fake-cloudflare.mjs"), dist("adapters/_node-authoritative-dns.js"), dist("edge/dns-wire.js"), dist("adapters/_node-site-fetch.js"),
    ]);
  // Platform marketplace refresh inherits an empty source list. Native App workers have no remote sources by default.
  process.env.ZELAVIS_ALLOWLIST_SOURCES = "";
  const { apex, work, token } = config;
  const caFile = join(work, "ca.pem"), keyFile = join(work, "ca.key");
  command("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Zelavis Qualification Test CA",
    "-keyout", keyFile, "-out", caFile]);
  const ca = await readFile(caFile, "utf8");
  const edgeFixture = localEdge(scope, ca, await readFile(keyFile));
  // OpenSSL reads each CSR from stdin and signs the public key the actual ACME client generated.
  const nameservers = [`ns1.${apex}`, `ns2.${apex}`];
  const authority = await startDnsAuthority(scope, { zones: new Map([[apex, { ns: nameservers }]]) });
  const endpoint = { host: "127.0.0.1", port: authority.port };
  const dns = createAuthoritativeDnsTxtResolver({ recursiveServers: [authority.address], authoritativePort: authority.port, queryTimeoutMs: 500 });
  const { apiBase } = await startFakeCloudflare(scope, { apex, token, authority });
  const acme = await startAcmeFake(scope, {
    async verify({ type, identifier, token: challengeToken, keyAuthorization, dnsValue }) {
      if (type === "http-01") {
        const reply = await fetchNodeSite(new URL(`http://${edgeFixture.connect.http}/.well-known/acme-challenge/${challengeToken}`), {
          method: "GET", headers: { host: identifier }, signal: AbortSignal.timeout(5_000),
        });
        return reply.ok && await reply.text() === keyAuthorization;
      }
      const reply = await dnsQuery(codec, endpoint, `_acme-challenge.${identifier}`, "TXT", false);
      return reply.authoritative && reply.answers.some(({ data }) => data.type === "TXT" && data.strings.join("") === dnsValue);
    },
    issue({ csr, identifiers }) {
      assert.deepEqual(identifiers.map(({ value }) => value), identifiers[0]?.value.startsWith("*.") ? [`*.${apex}`] : [config.hostnames[0]]);
      const extensionFile = join(work, "leaf.ext");
      const base64 = Buffer.from(csr, "base64url").toString("base64").match(/.{1,64}/gu).join("\n");
      const requestPem = `-----BEGIN CERTIFICATE REQUEST-----\n${base64}\n-----END CERTIFICATE REQUEST-----\n`;
      // The name is controlled by this test. The signature and subject public key still come from the CSR.
      return command("openssl", ["x509", "-req", "-CA", caFile, "-CAkey", keyFile, "-CAcreateserial",
        "-days", "1", "-extfile", extensionFile, "-extensions", identifiers[0].value.startsWith("*.") ? "wildcard" : "manual"], {
        input: requestPem,
      });
    },
  });
  await writeFile(join(work, "leaf.ext"), `[manual]\nsubjectAltName=DNS:${config.hostnames[0]}\n[wildcard]\nsubjectAltName=DNS:*.${apex}\n`);
  const platformScope = resources();
  const stopPlatform = () => platformScope.close();
  scope.after(stopPlatform);
  const platform = await startPlatform(platformScope, { ...config, apiBase, dns, connect: edgeFixture.connect, directoryUrl: acme.directoryUrl }, dist, edgeFixture);
  return {
    ...platform, apiBase, connect: edgeFixture.connect, stopPlatform,
    readIntents: () => readFile(platform.recordIntents, "utf8"),
    recursive: name => dnsQuery(codec, endpoint, name, "TXT", true),
    async assertChallenges() {
      assert.deepEqual(acme.notified.map(({ type, identifier, wildcard }) => [type, identifier, wildcard]), [
        ["http-01", config.hostnames[0], false], ["dns-01", apex, true],
      ]);
    },
  };
}

const shellWord = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const normalizeIpv6 = address => new URL(`http://[${address}]/`).hostname.slice(1, -1);

async function remoteTest(scope, config, dist) {
  const { ssh, sshKey, address, iface, run, work, hostnames, bootstrapToken } = config;
  const directory = `/var/tmp/zv-domains-${run}`;
  const platformUnit = `zv-domains-${run}-platform.service`;
  const traefikUnit = `zv-domains-${run}-traefik.service`;
  const table = `zv_domains_${run}`;
  const traefik = `${directory}/traefik`;
  const sshOptions = [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2",
    ...(sshKey ? ["-i", sshKey, "-o", "IdentitiesOnly=yes"] : []),
  ];
  const remote = (line, input) => command("ssh", [...sshOptions, ssh, line], { input });
  const copy = (...files) => command("scp", [...sshOptions, "-q", ...files, `${ssh}:${directory}/`]);
  const addressRows = () => JSON.parse(remote("ip -j -6 address show")).flatMap(row =>
    row.addr_info.map(info => ({ ...info, iface: row.ifname })));
  const onHost = () => addressRows().find(row => normalizeIpv6(row.local) === address);
  const pids = () => {
    const units = remote("systemctl list-units --plain --type=service --state=running --no-legend 'zelavis*' 'traefik*'");
    return Object.fromEntries(units.split("\n").filter(Boolean).map(line => {
      const unit = line.trim().split(/\s+/u)[0];
      return [unit, remote(`systemctl show --property=MainPID --value ${shellWord(unit)}`)];
    }));
  };
  const node = remote("set -eu; test \"$(id -u)\" = 0; for tool in ip nft systemd-run; do command -v \"$tool\" >/dev/null; done; " +
    "node=/opt/zelavis/current/runtime/node/bin/node; if [ ! -x \"$node\" ]; then node=$(command -v node); fi; " +
    "\"$node\" -e 'if (+process.versions.node.split(\".\")[0] < 24) process.exit(1)'; " +
    "test -x \"$(dirname \"$node\")/npm\"; printf '%s' \"$node\"");
  const initialPids = pids();
  assert.ok(!onHost(), "The qualification IPv6 address is already assigned.");
  remote(`ip link show dev ${shellWord(iface)}`);
  const architecture = { x86_64: "x64", aarch64: "arm64" }[remote("uname -m")];
  assert.ok(architecture, "The disposable machine must be Linux x64 or arm64.");

  const [{ installTraefikRuntime }, release, codec] = await Promise.all([
    import("./runtime-assets.mjs"), readFile(join(root, "distribution/release.json"), "utf8").then(JSON.parse), dist("edge/dns-wire.js"),
  ]);
  const caSignal = timeout(30_000);
  const bundle = await Promise.all(stagingRoots.map(async name => {
    const reply = await fetch(`https://letsencrypt.org/certs/staging/${name}`, { signal: caSignal, redirect: "error" });
    assert.ok(reply.ok, `Staging root download failed (HTTP ${reply.status}) for ${name}.`);
    const pem = await reply.text();
    const cert = new X509Certificate(pem);
    assert.ok(cert.ca && cert.checkIssued(cert) && cert.verify(cert.publicKey), `Invalid staging root ${name}.`);
    return pem;
  }));
  const ca = bundle.join("\n");
  const packDirectory = join(work, "pack");
  await mkdir(packDirectory);
  command("pnpm", ["--filter", "zelavis", "pack", "--pack-destination", packDirectory], { cwd: root });
  const tarballs = (await readdir(packDirectory)).filter(name => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "Expected one packed Zelavis candidate.");
  await installTraefikRuntime(work, release.traefikVersion, { platform: "linux", architecture }, join(work, "cache"));
  operationSignal.signal.throwIfAborted();

  let created = false, addressRequested = false, tableRequested = false, traefikStarted = false, platformStarted = false;
  let tunnel;
  const listUnits = (...units) => remote(`systemctl list-units --all --full --plain --no-legend ${units.join(" ")}`);
  const stopUnit = unit => { if (listUnits(unit)) remote(`systemctl stop ${unit}`); };
  const tableExists = () => remote("nft list tables").split("\n").includes(`table ip6 ${table}`);
  const stopPlatform = () => {
    if (!platformStarted) return;
    stopUnit(platformUnit);
    platformStarted = false;
  };
  scope.after(async () => {
    const errors = [];
    const attempt = (label, action) => {
      try { action(); }
      catch (error) { errors.push(`${label}: ${error.message}`); }
    };
    attempt("stop Platform", stopPlatform);
    tunnel?.kill("SIGTERM");
    if (traefikStarted) attempt("stop Traefik", () => stopUnit(traefikUnit));
    if (tableRequested) attempt("remove redirect table", () => {
      if (tableExists()) remote(`nft delete table ip6 ${table}`);
      assert.ok(!tableExists(), "The temporary redirect table still exists.");
    });
    if (addressRequested) attempt("remove IPv6 address", () => {
      const row = onHost();
      if (row?.iface === iface && row.prefixlen === 128) remote(`ip -6 address del ${address}/128 dev ${shellWord(iface)}`);
      assert.ok(!onHost(), "The temporary IPv6 address still exists.");
    });
    if (platformStarted || traefikStarted) {
      attempt("check disposable units", () => {
        for (const unit of [platformUnit, traefikUnit]) {
          const pid = remote(`systemctl show --property=MainPID --value ${unit}`);
          assert.ok(pid === "" || pid === "0", `${unit} still has a PID`);
        }
      });
    }
    attempt("check existing PIDs", () => {
      const finalPids = pids();
      for (const [unit, pid] of Object.entries(initialPids)) assert.equal(finalPids[unit], pid, `${unit} changed PID`);
    });
    if (created) {
      if (process.env.ZELAVIS_QUALIFY_KEEP === "1" && (failures.length || errors.length)) {
        console.log(`Kept remote files at ${directory}.`);
      } else {
        attempt("remove remote files", () => remote(`rm -rf -- ${directory} && test ! -e ${directory}`));
      }
    }
    if (errors.length) throw new Error(errors.join("\n"));
  });

  remote(`test ! -e ${directory}`);
  created = true;
  remote(`mkdir -m 755 ${directory}`);
  const webPort = randomInt(20000, 40000), tlsPort = randomInt(40000, 60000);
  const configFile = join(work, "server.json");
  await writeFile(configFile, JSON.stringify({
    packageRoot: `${directory}/package`, work: `${directory}/data`, hostnames, bootstrapToken,
    directoryUrl: stagingDirectory, connect: { host: address, port: tlsPort, http: `[${address}]:${webPort}`, ca },
  }), { mode: 0o600 });
  const traefikConfig = join(work, "traefik.json");
  await writeFile(traefikConfig, JSON.stringify({
    global: { checkNewVersion: false, sendAnonymousUsage: false },
    entryPoints: { web: { address: `[${address}]:${webPort}` }, websecure: { address: `[${address}]:${tlsPort}` } },
    providers: { file: { directory: `${directory}/data/edge-state/active`, watch: true } },
  }));
  copy(join(packDirectory, tarballs[0]), script, join(work, "edge/traefik/traefik"), configFile, traefikConfig);
  remote(`set -eu; cd ${directory}; mkdir -m 700 data; mkdir -p data/edge-state/active; chown -R nobody data server.json; chmod 600 server.json; chmod 755 traefik; ` +
    `tar --no-same-owner -xzf ${shellWord(tarballs[0])}; cd package; export PATH=${shellWord(dirname(node))}:$PATH; ` +
    "npm install --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error");

  addressRequested = true;
  remote(`ip -6 address add ${address}/128 dev ${shellWord(iface)}`);
  await until("IPv6 address readiness", 15_000, 500, () => {
    const row = onHost();
    assert.ok(!row?.dadfailed, "IPv6 duplicate address detection failed.");
    return row?.iface === iface && !row.tentative;
  });
  assert.ok(!tableExists(), "The qualification nftables table already exists.");
  tableRequested = true;
  remote("nft -f -", `table ip6 ${table} {
    chain ingress {
      type nat hook prerouting priority -105; policy accept;
      ip6 daddr ${address} tcp dport 80 dnat to [${address}]:${webPort}
      ip6 daddr ${address} tcp dport 443 dnat to [${address}]:${tlsPort}
    }
  }\n`);
  const limits = "--collect --uid=nobody --property=RuntimeMaxSec=25min --property=TimeoutStopSec=20s --property=UMask=0077";
  traefikStarted = true;
  remote(`systemd-run --unit=${traefikUnit} --property=MemoryMax=256M ${limits} ${traefik} --configFile=${directory}/traefik.json`);
  platformStarted = true;
  remote(`systemd-run --unit=${platformUnit} --property=MemoryMax=1G ${limits} ${shellWord(node)} ${directory}/qualify-domains.mjs --remote-worker ${directory}/server.json`);
  const portFile = `${directory}/data/management-port`;
  const remotePort = await until("disposable Platform management listener", 45_000, 1_000, () => {
    const port = remote(`if test -s ${portFile}; then cat ${portFile}; fi`);
    if (/^[1-9][0-9]{0,4}$/u.test(port)) return Number(port);
    const state = remote(`systemctl show --property=ActiveState --value ${platformUnit}`);
    assert.notEqual(state, "failed", `The disposable Platform failed to start. Inspect ${platformUnit} in the journal.`);
    return undefined;
  });
  const portScope = resources();
  const localPort = await listen(portScope, netServer());
  await portScope.close();
  tunnel = spawn("ssh", [...sshOptions, "-N", "-o", "ExitOnForwardFailure=yes",
    "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ssh], { env: commandEnv, stdio: "ignore" });
  let tunnelError;
  tunnel.once("error", error => { tunnelError = error; });
  const origin = `http://127.0.0.1:${localPort}`;
  await until("the SSH management tunnel", 20_000, 200, async () => {
    if (tunnelError) throw tunnelError;
    assert.equal(tunnel.exitCode, null, "SSH tunnel exited.");
    try {
      const response = await fetch(origin + mount + "/auth/bootstrap", { signal: timeout(2_000) });
      const body = await response.json();
      return response.ok && body.required === true;
    } catch (error) {
      if (error instanceof TypeError || error.name === "TimeoutError") return false;
      throw error;
    }
  });
  return {
    origin, connect: { host: address, ca }, stopPlatform,
    readIntents: () => remote(`cat ${directory}/data/dns-intents.jsonl`),
    recursive: (name, type = "TXT") => dnsQuery(codec, { host: config.recursiveIpv4, port: 53 }, name, type, true),
  };
}

async function remoteWorker(filename) {
  const config = JSON.parse(await readFile(filename, "utf8"));
  const scope = resources();
  const dist = distAt(config.packageRoot);
  const { shutdownOnSignals } = await dist("runtimes/node.js");
  shutdownOnSignals(() => scope.close());
  try {
    const platform = await startPlatform(scope, config, dist);
    await writeFile(join(config.work, "management-port"), String(new URL(platform.origin).port));
  } catch (error) {
    await scope.close();
    throw error;
  }
}

async function platformApi(environment, bootstrapToken) {
  const { origin } = environment;
  const password = randomBytes(30).toString("base64url");
  const headers = { origin, ...jsonHeaders };
  const setup = await fetch(origin + mount + "/auth/bootstrap", {
    method: "POST", headers, signal: timeout(30_000),
    body: JSON.stringify({ bootstrapToken, username: "domains-owner", displayName: "Domain qualification", password }),
  });
  assert.ok(setup.ok, `Owner bootstrap returned HTTP ${setup.status}.`);
  await setup.body?.cancel();
  const session = setup.headers.getSetCookie().find(value => value.startsWith("zelavis_access="))?.split(";", 1)[0];
  assert.ok(session, "Owner bootstrap did not issue the Platform session cookie.");
  return async (path, { method = "GET", body, statuses = [200], ms = 30_000, cleanup = false, signal } = {}) => {
    const deadline = timeout(ms, cleanup);
    const response = await fetch(origin + mount + path, {
      method, headers: { ...headers, cookie: session }, signal: signal ? AbortSignal.any([deadline, signal]) : deadline, redirect: "error",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = response.status === 204 ? undefined : await response.json();
    assert.ok(statuses.includes(response.status), `${method} ${path} returned HTTP ${response.status} (${data?.code ?? "no error code"}).`);
    return data;
  };
}

const txtContent = value => value.replace(/^"(.*)"$/u, "$1");
const negative = reply => (reply.rcode === 0 || reply.rcode === 3) && reply.answers.length === 0;
const domainPath = `/runtime/projects/${projectId}/domains`;
const dnsPath = "/runtime/edge/dns";
const cloudflarePath = dnsPath + "/connections/cloudflare";
const challengeFor = host => "_zelavis-challenge." + host;
const ipMatches = (record, address) => record.type === "AAAA" && normalizeIpv6(record.content) === normalizeIpv6(address);

async function zoneFor(client, apex) {
  let cursor;
  for (let page = 0; page < 100; page += 1) {
    const answer = await client.zones({ cursor });
    const zone = answer.zones.find(zone => zone.apex === apex);
    if (zone) return zone;
    if (!answer.next) break;
    cursor = answer.next;
  }
  throw new Error(`Cloudflare did not list the configured zone ${apex}.`);
}

async function cloudflareClient(config, dist, apiBase) {
  const { createCloudflareDnsProvider } = await dist("adapters/_dns-cloudflare.js");
  return createCloudflareDnsProvider({ apiBase }).createClient({ apiToken: config.token }, {
    fetch: (url, options) => fetch(url, { ...options, signal: timeout(10_000, true) }),
  });
}

async function runLegs(config, environment, client, zone) {
  const { apex, address, hostnames } = config;
  const [manual, automatic] = hostnames;
  const zonePath = dnsPath + "/zones/" + apex;
  const wildcardTxt = "_acme-challenge." + apex;
  const manualRecords = [];
  const existingWildcard = new Set((await client.records(zone.id, { name: wildcardTxt, type: "TXT" })).map(row => row.id));
  const list = (name, type) => client.records(zone.id, { name, type });
  const trackedNames = hostnames.flatMap(name => [name, challengeFor(name)]);
  for (const name of trackedNames) {
    for (const type of domainTypes) assert.equal((await list(name, type)).length, 0, `${name} already has a ${type} record.`);
  }
  const create = async (name, type, content) => {
    const record = await client.create(zone.id, { name, type, content, ttl: 60 });
    manualRecords.push(record.id);
  };
  const domain = async (api, host, options) => (await api(domainPath, options)).domains.find(row => row.hostname === host);
  const verify = (api, entry, signal) => api(`${domainPath}/${entry.hostname}/verify`, {
    method: "POST", body: { expectedRevision: entry.revision }, statuses: [200, 202, 422, 429], ms: 95_000, signal,
  });
  const waitForActive = async (api, host, initial) => {
    let state = initial;
    const signal = timeout(300_000);
    try {
      return await until(`${host} to become active`, 300_000, 2_000, async () => {
        const entry = await domain(api, host, { signal });
        state = entry.state === "active" ? entry : await verify(api, entry, signal);
        return state.state === "active" ? state : undefined;
      }, signal);
    } catch (error) {
      throw new Error(`${error.message} Last response: ${state?.state ?? "unknown"} / ${state?.issue ?? state?.code ?? "none"}.`);
    }
  };

  let api, projectCreated = false, connected = false, adopted = false, stage = "setup";
  try {
    api = await platformApi(environment, config.bootstrapToken);
    await api("/runtime/projects", {
      method: "POST", statuses: [200, 201, 202], ms: 90_000,
      body: { id: projectId, name: "Domain qualification", recipeName: "@zelavis/app", start: true },
    });
    projectCreated = true;
    const registrationPath = `/runtime/projects/${projectId}/auth/registration/settings`;
    const registration = await api(registrationPath);
    await api(registrationPath, { method: "PUT", body: { enabled: true, expectedRevision: registration.revision } });

    stage = "manual-txt";
    await create(manual, "AAAA", address);
    const seeded = await environment.recursive(challengeFor(manual));
    assert.ok(negative(seeded), "The recursive DNS query did not seed a negative TXT response.");
    const added = await api(domainPath, { method: "POST", body: { hostname: manual, tlsMode: "managed" }, statuses: [201] });
    assert.equal(added.challenge?.name, challengeFor(manual));
    const before = await verify(api, added);
    assert.equal(before.code, "dns_not_verified", "A check before the TXT record exists must fail.");
    await create(added.challenge.name, "TXT", added.challenge.value);
    let verified;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await delay(31_000, undefined, { signal: operationSignal.signal });
      assert.ok(negative(await environment.recursive(added.challenge.name)), "Recursive cache no longer answers negatively.");
      verified = await verify(api, await domain(api, manual));
      assert.ok(negative(await environment.recursive(added.challenge.name)), "Recursive cache expired before the verification result.");
      if (verified.verifiedAt) break;
      assert.ok(verified.code === "dns_not_verified" || verified.code === "domain_verification_busy",
        `Unexpected verification result: ${verified.code}.`);
    }
    assert.ok(verified?.verifiedAt, "Authoritative TXT verification did not succeed while the recursive answer was negative.");
    console.log("PASS manual-txt");

    stage = "http-01";
    await waitForActive(api, manual, verified);
    const publicSite = async hostname => {
      if (!config.selfTest) {
        await until(`${hostname} public AAAA`, 30_000, 2_000, async () => {
          const answer = await environment.recursive(hostname, "AAAA");
          return answer.answers.some(({ data }) => data.type === "AAAA" && normalizeIpv6(data.address) === address);
        });
      }
      const proof = await httpsProof(environment.connect, hostname, "/");
      assert.equal(proof.status, 503, `Native App placeholder on ${hostname}`);
      assert.match(proof.text, /<h1>[^<]+ has no frontend yet<\/h1>/u);
      assert.ok(proof.certificate.raw, "HTTPS must present a verifiable leaf certificate.");
      return new X509Certificate(proof.certificate.raw);
    };
    const leaf = await publicSite(manual);
    assert.equal(leaf.subjectAltName, `DNS:${manual}`);
    const signup = await httpsProof(environment.connect, manual, mount + "/auth/username-password/sign-up", {
      body: { username: "domains-customer", password: randomBytes(30).toString("base64url") },
    });
    assert.equal(signup.status, 200, "The bound App allows username signup.");
    const cookie = signup.headers["set-cookie"]?.find(value => /^zelavis_app_[a-f0-9]{24}=/u.test(value));
    assert.ok(cookie && /;\s*HttpOnly\b/iu.test(cookie) && /;\s*Secure\b/iu.test(cookie),
      "Signup must issue a Secure HttpOnly App access cookie.");
    const admin = await httpsProof(environment.connect, manual, mount + "/auth/accounts");
    assert.equal(admin.status, 404, "The bound App must refuse the administrative Auth route.");
    console.log("PASS http-01");

    stage = "dns-01-wildcard";
    await api(cloudflarePath, { method: "PUT", body: { credentials: { apiToken: config.token } } });
    connected = true;
    await api(zonePath, {
      method: "PUT", body: { provider: "cloudflare", zoneId: zone.id, hostedSubdomains: true, targets: { a: [], aaaa: [address] } },
    });
    adopted = true;
    const { certificate } = await api(zonePath + "/wildcard-certificate", { method: "POST", ms: 305_000 });
    assert.equal(certificate.hostname, "*." + apex);
    assert.equal(certificate.status, "valid");
    assert.ok((await list(wildcardTxt, "TXT")).every(row => existingWildcard.has(row.id)), "ACME left a new DNS-01 TXT record.");
    console.log("PASS dns-01-wildcard");

    stage = "automatic";
    const hosted = await api(domainPath, {
      method: "POST", body: { hostname: automatic, tlsMode: "managed", dns: "automatic" }, statuses: [201], ms: 95_000,
    });
    const active = await waitForActive(api, automatic, hosted);
    assert.equal(active.dns, "automatic");
    const published = await list(automatic, "AAAA");
    assert.equal(published.length, 1, "Automation must publish one AAAA.");
    assert.ok(ipMatches(published[0], address), "Automation published the wrong IPv6 address.");
    assert.equal((await publicSite(automatic)).subjectAltName, `DNS:*.${apex}`);
    await environment.assertChallenges?.();
    console.log("PASS automatic");
  } catch (error) {
    fail(stage, error);
  } finally {
    const attempt = async (label, action) => {
      try { await action(); }
      catch (error) { fail("cleanup", new Error(`${label}: ${error.message}`)); }
    };
    if (projectCreated) {
      for (const hostname of [automatic, manual]) {
        await attempt(`withdraw ${hostname}`, () => until(`${hostname} withdrawal`, 30_000, 1_000, async () => {
          const current = await domain(api, hostname, { cleanup: true });
          if (!current) return true;
          const result = await api(`${domainPath}/${hostname}?revision=${current.revision}`, {
            method: "DELETE", statuses: [200, 202], cleanup: true,
          });
          return result.removed;
        }, AbortSignal.timeout(35_000)));
      }
      await attempt("check automatic records were withdrawn", async () => {
        for (const name of [automatic, challengeFor(automatic)]) {
          for (const type of domainTypes) assert.equal((await list(name, type)).length, 0, `${type} remains for ${name}`);
        }
      });
    }
    if (adopted) await attempt("release zone", () => api(zonePath, { method: "DELETE", statuses: [204], cleanup: true }));
    if (connected) await attempt("disconnect DNS provider", () => api(cloudflarePath, { method: "DELETE", statuses: [204], cleanup: true }));
    await attempt("stop DNS writers", async () => { await environment.stopPlatform?.(); });
    for (const id of manualRecords) await attempt("delete manual DNS record", () => client.remove(zone.id, id));
    for (const name of trackedNames) {
      for (const type of domainTypes) {
        await attempt(`sweep ${type} for ${name}`, async () => {
          for (const row of await list(name, type)) await client.remove(zone.id, row.id);
          assert.equal((await list(name, type)).length, 0, `DNS records still exist for ${name}`);
        });
      }
    }
    await attempt("sweep this run's wildcard challenge", async () => {
      const intents = (await environment.readIntents()).split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(row => row.name === wildcardTxt && row.type === "TXT");
      const values = new Set(intents.map(row => txtContent(row.content)));
      const ids = new Set(intents.flatMap(row => row.id ? [row.id] : []));
      const own = row => !existingWildcard.has(row.id) && (ids.has(row.id) || values.has(txtContent(row.content)));
      for (const row of (await list(wildcardTxt, "TXT")).filter(own)) await client.remove(zone.id, row.id);
      assert.ok(!(await list(wildcardTxt, "TXT")).some(own), "A qualification wildcard TXT record still exists.");
    });
  }
}

function configuration(selfTest, work) {
  const required = ["SSH", "ZONE", "CLOUDFLARE_TOKEN", "IPV6", "IFACE"];
  const get = name => process.env[prefix + name];
  const missing = required.filter(name => !get(name));
  assert.ok(selfTest || missing.length === 0, `Set ${missing.map(name => prefix + name).join(", ")}.`);
  const run = process.pid.toString(36) + Date.now().toString(36).slice(-7);
  const apex = selfTest ? "domains.example.com" : get("ZONE").toLowerCase().replace(/\.$/u, "");
  assert.ok(apex.length <= 220 && apex.split(".").length >= 2 &&
    apex.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)), "Invalid DNS zone name.");
  const ipv6 = selfTest ? "2001:db8::7" : get("IPV6");
  assert.equal(isIP(ipv6), 6, "An unscoped IPv6 address is required.");
  const address = normalizeIpv6(ipv6);
  const ssh = get("SSH"), iface = get("IFACE");
  const recursiveIpv4 = get("RECURSIVE_IPV4") || "1.1.1.1";
  assert.equal(isIP(recursiveIpv4), 4, "RECURSIVE_IPV4 must be an IPv4 address.");
  const token = selfTest ? randomBytes(30).toString("base64url") : get("CLOUDFLARE_TOKEN");
  if (!selfTest) {
    assert.ok(/^[a-z_][a-z0-9_-]*@[a-zA-Z0-9][a-zA-Z0-9.-]*$/u.test(ssh), "SSH must be user@hostname.");
    assert.ok(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,14}$/u.test(iface), "Invalid Linux interface name.");
    assert.ok(/^[\x21-\x7e]{1,512}$/u.test(token), "Invalid Cloudflare token format.");
    assert.ok(/^[23][a-f0-9]{3}:/u.test(address), "Use a routed public IPv6 address.");
  }
  return {
    selfTest, work, run, apex, address, ssh, iface, recursiveIpv4, sshKey: get("SSH_KEY"), token,
    packageRoot: join(root, "packages/zelavis"),
    hostnames: [`m-${run}.${apex}`, `a-${run}.${apex}`],
    bootstrapToken: randomBytes(32).toString("base64url"),
  };
}

async function main(args) {
  assert.ok(args.length === 0 || (args.length === 1 && args[0] === "--self-test"), "Usage: qualify-domains.mjs [--self-test]");
  const local = args[0] === "--self-test";
  const commit = command("git", ["rev-parse", "HEAD"], { cwd: root });
  const work = await mkdtemp(join(tmpdir(), "zv-domains-"));
  const scope = resources();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const interrupt = () => operationSignal.abort(new Error("Qualification interrupted."));
  for (const signal of signals) process.on(signal, interrupt);
  const deadline = setTimeout(() => operationSignal.abort(new Error("Qualification exceeded its work deadline.")), 25 * 60_000);
  try {
    const config = configuration(local, work);
    const dist = distAt(config.packageRoot);
    let environment, client, zone;
    if (local) {
      environment = await selfTest(scope, config, dist);
      client = await cloudflareClient(config, dist, environment.apiBase);
      zone = await zoneFor(client, config.apex);
    } else {
      client = await cloudflareClient(config, dist);
      zone = await zoneFor(client, config.apex);
      const dirty = command("git", ["status", "--porcelain"], { cwd: root });
      console.log(`Run ${config.run}: ${config.apex} at ${commit}${dirty ? " (working-tree candidate)" : ""}; recursive ${config.recursiveIpv4}`);
      environment = await remoteTest(scope, config, dist);
    }
    await runLegs(config, environment, client, zone);
  } catch (error) {
    fail("setup", error);
  } finally {
    try { await scope.close(); }
    catch (error) { fail("cleanup", error); }
    clearTimeout(deadline);
    for (const signal of signals) process.off(signal, interrupt);
    if (process.env.ZELAVIS_QUALIFY_KEEP === "1" && failures.length) console.log(`Kept local files at ${work}.`);
    else await rm(work, { recursive: true, force: true });
  }
  if (!failures.includes("cleanup") && !failures.includes("setup")) console.log("PASS cleanup");
  if (failures.length) process.exitCode = 1;
  else console.log(local ? `SELF-TEST PASSED ${commit}` : `QUALIFIED ${commit}`);
}

try {
  const args = process.argv.slice(2);
  if (args[0] === "--remote-worker") await remoteWorker(args[1]);
  else await main(args);
} catch (error) {
  fail("setup", error);
  process.exitCode = 1;
}
