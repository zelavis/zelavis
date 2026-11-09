// The remote Agent of the shard drill: hosts App shards for a Platform on another container or machine. It trusts the
// Platform's keys from <root>/shared/trust.json, which the Platform publishes once it is up, and re-reads them on every call.
// In a container every path is the default; on a separate machine (qualify-shards.mjs with ZELAVIS_QUALIFY_SHARDS_AGENT_SSH)
// ZELAVIS_DRILL_ROOT names the drill's own directory, ZELAVIS_DRILL_PACKAGE the unpacked candidate and ZELAVIS_DRILL_LISTEN the
// loopback address its SSH tunnel reaches.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.ZELAVIS_DRILL_ROOT ?? "/";
const packageRoot = process.env.ZELAVIS_DRILL_PACKAGE ?? "/repo/packages/zelavis";
const [host, port] = (process.env.ZELAVIS_DRILL_LISTEN ?? "0.0.0.0:8443").split(":");
const { createRemoteProjectAgent } = await import(join(packageRoot, "dist/adapters/_remote-project-agent.js"));
const trustFile = join(root, "shared/trust.json");
const trust = () => existsSync(trustFile) ? JSON.parse(readFileSync(trustFile, "utf8")) : { keys: [] };
const agent = await createRemoteProjectAgent({
  dataDirectory: join(root, "data"), host, port: Number(port),
  keyPem: readFileSync(join(root, "certs/tls.key"), "utf8"), certPem: readFileSync(join(root, "certs/tls.crt"), "utf8"),
  trust, agentId: "agent-b", nodeId: "node-b",
});
console.log(JSON.stringify({ event: "agent-ready", address: agent.address }));
process.on("SIGUSR1", () => console.log(JSON.stringify({ event: "reads", served: agent.shardReadsServed() })));
process.on("SIGTERM", async () => { await agent.close(); process.exit(0); });
setInterval(() => undefined, 1 << 30);
