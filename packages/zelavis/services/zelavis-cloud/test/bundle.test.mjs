// The bundled service is what a Platform actually loads: no Alchemy, Hetzner client or
// Node platform layer is installed beside it, only `effect` and `zelavis`.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { createMemorySystemStore } from "zelavis";
import { startFakeHetzner } from "./fake-hetzner.mjs";

const bundle = join(dirname(fileURLToPath(import.meta.url)), "..", "bundle");
const GB = 1024 ** 3;

test("the bundle's static imports are only effect, zelavis and node: built-ins", () => {
  // The bundler hoists every static import to the head of the file; generated-code templates later
  // in the file contain `import` text that is data, not a dependency.
  const specifiers = [];
  for (const line of readFileSync(join(bundle, "index.js"), "utf8").split("\n")) {
    const match = /^import\b.*?(?:\bfrom\s+)?"([^"]+)";$/.exec(line);
    if (match) specifiers.push(match[1]);
    else if (line.trim() !== "" && !line.startsWith("//") && !line.startsWith("/*") && !line.startsWith(" *")) break;
  }
  assert.ok(specifiers.length > 5, "found the import block");
  const foreign = [...new Set(specifiers)].filter((s) => !(builtinModules.includes(s.replace(/^node:/, "")) || s === "effect" || s.startsWith("effect/") || s === "zelavis" || s.startsWith("zelavis/")));
  assert.deepEqual(foreign, []);
});

test("the import.meta.resolve patch applied, and never reaches a bare module", () => {
  assert.ok(Number(readFileSync(join(bundle, "PATCHED_MODULES"), "utf8")) >= 1, "Alchemy's module-scope import.meta.resolve was not found; re-verify the patch");
  assert.ok(!readFileSync(join(bundle, "index.js"), "utf8").includes('import.meta.resolve("alchemy'));
});

test("a machine is created and released through the bundle alone", async (t) => {
  const fake = await startFakeHetzner();
  t.after(() => fake.close());
  const { createHetznerCapacityProvider } = await import(join(bundle, "index.js"));
  const provider = createHetznerCapacityProvider({
    token: fake.token, endpoint: fake.url, platformId: "platform-1", workerId: "worker-1",
    workDir: mkdtempSync(join(tmpdir(), "zelavis-bundle-")), store: createMemorySystemStore(), secretKey: randomBytes(32),
    defaults: { location: "nbg1", image: "ubuntu-24.04", maxNodes: 2, machineClasses: [{ name: "cpx11", cpuCores: 2, memoryBytes: 2 * GB, diskBytes: 40 * GB }] },
    enrollment: { isEnrolled: () => false },
    userData: ({ nodeId }) => `#!/bin/sh\necho ${nodeId}\n`,
  });
  const node = await provider.provision({ requestId: "req-1", platformId: "platform-1" });
  assert.equal(node.state, "provisioning");
  const [server] = [...fake.servers.values()];
  assert.equal(server.name, node.id);
  assert.match(server.user_data ?? "", /echo zelavis-/);
  await provider.release(node.id);
  assert.equal(fake.servers.size, 0);
});
