// The remote Agent of the shard drill: hosts App shards for a Platform in another container. It trusts the Platform's
// keys from /shared/trust.json, which the Platform publishes once it is up, and re-reads them on every call.
import { existsSync, readFileSync } from "node:fs";
import { createRemoteProjectAgent } from "/repo/packages/zelavis/dist/adapters/_remote-project-agent.js";

const trust = () => existsSync("/shared/trust.json") ? JSON.parse(readFileSync("/shared/trust.json", "utf8")) : { keys: [] };
const agent = await createRemoteProjectAgent({
  dataDirectory: "/data", host: "0.0.0.0", port: 8443,
  keyPem: readFileSync("/certs/tls.key", "utf8"), certPem: readFileSync("/certs/tls.crt", "utf8"),
  trust, agentId: "agent-b", nodeId: "node-b",
});
console.log(JSON.stringify({ event: "agent-ready", address: agent.address }));
process.on("SIGUSR1", () => console.log(JSON.stringify({ event: "reads", served: agent.shardReadsServed() })));
process.on("SIGTERM", async () => { await agent.close(); process.exit(0); });
setInterval(() => undefined, 1 << 30);
