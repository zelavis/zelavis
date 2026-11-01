// A real Platform runtime behind a real HTTPS listener, started only by the worker
// qualification, inside its disposable container. It is a test harness process, not
// an installation: it issues an enrollment, serves the enroll route, and reports the
// state of the node in its own Fabric inventory so the harness shell can wait on it.
import { X509Certificate } from "node:crypto";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dist = "/workspace/packages/zelavis/dist";
const { zelavis } = await import(`${dist}/index.js`);
const { nodeAdapter } = await import(`${dist}/adapters/node.js`);
const { generateAgentCertificate } = await import(`${dist}/adapters/_agent-certificate.js`);

const NODE_ID = process.env.WORKER_NODE_ID ?? "worker-1";
const OWNER = { id: "owner", type: "user", permissions: ["*"] };
const data = await mkdtemp(join(tmpdir(), "zelavis-qualify-platform-"));
const adapter = nodeAdapter({
  dataDirectory: data, services: false,
  projects: { directory: join(data, "projects"), remoteDispatch: { localNodeId: "platform", nodes: {} } },
});
const resolved = await adapter.resolve({});
const runtime = await zelavis({ systemStore: resolved.resources.systemStore, resolvePrincipal: () => OWNER });
const { keyPem, certPem } = generateAgentCertificate({ names: ["127.0.0.1"] });

const server = createServer({ key: keyPem, cert: certPem }, (incoming, outgoing) => {
  const chunks = [];
  incoming.on("data", (chunk) => chunks.push(chunk));
  incoming.on("end", async () => {
    const body = Buffer.concat(chunks);
    const response = await runtime.fetch(new Request(`https://127.0.0.1${incoming.url}`, {
      method: incoming.method, headers: incoming.headers, ...(body.length ? { body } : {}),
    }));
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
});
await new Promise((resolve) => server.listen(9443, "127.0.0.1", resolve));

const issued = await runtime.fetch(new Request("http://localhost/zelavis/api/v1/runtime/nodes/enrollments", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeId: NODE_ID }),
}));
if (issued.status !== 201) throw new Error(`could not issue an enrollment: ${issued.status} ${await issued.text()}`);
const { token } = await issued.json();

const atomically = async (file, text) => { await writeFile(`${file}.tmp`, text); await rename(`${file}.tmp`, file); };
await atomically("/tmp/platform.json", JSON.stringify({
  url: "https://127.0.0.1:9443", fingerprint: new X509Certificate(certPem).fingerprint256, token, nodeId: NODE_ID,
}));

// The node's state as the Platform's own Fabric inventory sees it, once a second.
setInterval(async () => {
  const nodes = await resolved.subsystems.fabric.inventory.nodes();
  await atomically("/tmp/node-status", `${nodes.find((node) => node.id === NODE_ID)?.status ?? "absent"}\n`);
}, 1000);
