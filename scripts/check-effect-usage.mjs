#!/usr/bin/env node
import { parse } from "@babel/parser";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = join(root, "scripts/effect-migration-baseline.json");
export const migratedFiles = new Set([
  "packages/zelavis/src/project.ts", "packages/zelavis/src/core/runtime/lifecycle.ts",
  "packages/zelavis/src/adapters/_local-project-runtime.ts", "packages/zelavis/src/adapters/_node-project-runtime.ts",
  "packages/zelavis/src/adapters/_server-frontend-project-runtime.ts", "packages/zelavis/src/adapters/_node-updates.ts",
  "packages/zelavis/src/adapters/_update-runner.ts", "zelavis-services/wordpress/src/runtime.ts",
  "packages/zelavis/src/core/runtime/admission.ts", "packages/zelavis/src/core/runtime/handover.ts",
  "packages/zelavis/src/adapters/_node-runtime-ingress.ts", "packages/zelavis/src/adapters/_node-runtime-supervisor.ts",
  "packages/zelavis/src/adapters/_node-runtime-worker.ts", "packages/zelavis/src/adapters/_node-project-runner.ts",
  "packages/zelavis/src/adapters/_node-project-engine.ts", "packages/zelavis/src/adapters/_node-platform-engine.ts",
  "packages/zelavis/src/adapters/_node-runtime-gateway.ts", "packages/zelavis/src/adapters/_node-runtime-journal.ts",
  "packages/zelavis/src/adapters/_node-project-release.ts",
  "packages/zelavis/src/adapters/_managed-recipe-update.ts",
  "packages/zelavis/src/adapters/_node-runtime-artifact.ts", "packages/zelavis/src/adapters/_node-runtime-catalog.ts",
  "packages/zelavis/src/adapters/_release-tree.ts",
  "packages/zelavis/src/adapters/_node-project-host.ts", "packages/zelavis/src/adapters/_node-runtime-ownership.ts",
  "packages/zelavis/src/adapters/_node-runtime-commands.ts",
  "packages/zelavis/src/adapters/_node-runtime-client.ts",
  "packages/zelavis/src/adapters/_installation-runtime.ts",
  "packages/zelavis/src/adapters/_node-platform-host.ts", "packages/zelavis/src/adapters/_node-runtime-control.ts",
  "packages/zelavis/src/adapters/_node-runtime-selection.ts", "packages/zelavis/src/adapters/_node-runtime-select-cli.ts",
  "packages/zelavis/src/core/runtime/installation-plan.ts", "packages/zelavis/src/core/runtime/installation-health.ts",
  "packages/zelavis/src/cli/install/index.ts", "packages/zelavis/src/cli/update.ts",
  "packages/zelavis/src/cli.ts", "packages/zelavis/src/cli/nodes.ts", "packages/zelavis/src/cli/worker.ts",
  "packages/zelavis/src/cli/install/worker.ts", "packages/zelavis/src/adapters/_node-installation-uninstaller.ts",
  "packages/zelavis/src/adapters/_remote-node-sources.ts", "packages/zelavis/src/adapters/_pinned-fetch.ts",
  "packages/zelavis/src/platform/node-enrollment.ts", "packages/zelavis/src/platform/node-routes.ts",
  "packages/zelavis/src/core/runtime/worker-installation-plan.ts",
  "packages/zelavis/src/adapters/_install-host.ts", "packages/zelavis/src/adapters/node.ts",
  "packages/zelavis/src/adapters/_project-dispatch-https.ts", "packages/zelavis/src/cli/commands.ts",
  "packages/zelavis/services/zelavis-marketplace/src/allowlist/client.ts",
  "packages/zelavis/services/zelavis-marketplace/src/allowlist/gate.ts",
  "packages/zelavis/src/adapters/_agent-host-operations.ts",
  "packages/zelavis/src/adapters/_agent-ipc.ts",
  "packages/zelavis/src/adapters/_agent-process-runner.ts",
  "packages/zelavis/src/adapters/_agent-remote-environment.ts",
  "packages/zelavis/src/adapters/_host-package-policy.ts",
  "packages/zelavis/src/adapters/_linux-cgroup-supervisor.ts",
  "packages/zelavis/src/adapters/_local-ownership.ts",
  "packages/zelavis/src/adapters/_local-runtime.ts",
  "packages/zelavis/src/adapters/_marketplace-allowlist.ts",
  "packages/zelavis/src/adapters/_node-artifact-store.ts",
  "packages/zelavis/src/adapters/_node-backend-host.ts",
  "packages/zelavis/src/adapters/_node-host-operation-executor.ts",
  "packages/zelavis/src/adapters/_node-site-fetch.ts",
  "packages/zelavis/src/adapters/_package-acquisition.ts",
  "packages/zelavis/src/adapters/_package-scaffold.ts",
  "packages/zelavis/src/adapters/_platform-authority-key.ts",
  "packages/zelavis/src/adapters/_recipe-artifact.ts",
  "packages/zelavis/src/adapters/_remote-project-agent.ts",
  "packages/zelavis/src/adapters/_remote-project-snapshot.ts",
  "packages/zelavis/src/adapters/_shared.ts",
  "packages/zelavis/src/adapters/bun.ts",
  "packages/zelavis/src/agent/operation-journal.ts",
  "packages/zelavis/src/app/app-service.ts",
  "packages/zelavis/src/app/identity/core/create-identity.ts",
  "packages/zelavis/src/app/identity/core/password.ts",
  "packages/zelavis/src/app/identity/core/session-authenticator.ts",
  "packages/zelavis/src/app/identity/identity-service.ts",
  "packages/zelavis/src/app/identity/providers/oauth-connections.ts",
  "packages/zelavis/src/app/identity/providers/oauth-discovery.ts",
  "packages/zelavis/src/app/identity/providers/oauth-flow.ts",
  "packages/zelavis/src/app/identity/providers/oauth-runtime.ts",
  "packages/zelavis/src/app/identity/providers/password.ts",
  "packages/zelavis/src/app/identity/services/account-service.ts",
  "packages/zelavis/src/app/identity/services/authentication-service.ts",
  "packages/zelavis/src/app/identity/services/credential-service.ts",
  "packages/zelavis/src/app/identity/services/security-service.ts",
  "packages/zelavis/src/app/identity/services/session-service.ts",
  "packages/zelavis/src/app/identity/storage/database.ts",
  "packages/zelavis/src/app/identity/storage/in-memory.ts",
  "packages/zelavis/src/app/identity/storage/unique-claims.ts",
  "packages/zelavis/src/app/workloads/workloads-service.ts",
  "packages/zelavis/src/assistant-approvals.ts",
  "packages/zelavis/src/assistant-audit.ts",
  "packages/zelavis/src/assistant-model.ts",
  "packages/zelavis/src/assistant-provider.ts",
  "packages/zelavis/src/assistant-tools.ts",
  "packages/zelavis/src/assistant.ts",
  "packages/zelavis/src/backends/docker/index.ts",
  "packages/zelavis/src/backends/native/index.ts",
  "packages/zelavis/src/backends/registry.ts",
  "packages/zelavis/src/bundle-store.ts",
  "packages/zelavis/src/cli/agent.ts",
  "packages/zelavis/src/cli/auth.ts",
  "packages/zelavis/src/cli/bootstrap.ts",
  "packages/zelavis/src/cli/data.ts",
  "packages/zelavis/src/cli/edge.ts",
  "packages/zelavis/src/cli/host-operations.ts",
  "packages/zelavis/src/cli/install/doctor.ts",
  "packages/zelavis/src/cli/marketplace.ts",
  "packages/zelavis/src/cli/plugins.ts",
  "packages/zelavis/src/cli/prompt.ts",
  "packages/zelavis/src/cli/services.ts",
  "packages/zelavis/src/cli/setup.ts",
  "packages/zelavis/src/core/agent/index.ts",
  "packages/zelavis/src/core/agent/placement-lease.ts",
  "packages/zelavis/src/core/agent/project-dispatch.ts",
  "packages/zelavis/src/core/agent/remote-placement.ts",
  "packages/zelavis/src/core/artifact/index.ts",
  "packages/zelavis/src/core/deployment/index.ts",
  "packages/zelavis/src/core/fabric/index.ts",
  "packages/zelavis/src/core/runtime/authentication.ts",
  "packages/zelavis/src/core/runtime/basic-authentication.ts",
  "packages/zelavis/src/core/runtime/create-runtime.ts",
  "packages/zelavis/src/core/runtime/jwt-authentication.ts",
  "packages/zelavis/src/core/runtime/node-http-shared.ts",
  "packages/zelavis/src/core/runtime/node-http.ts",
  "packages/zelavis/src/core/runtime/request-dispatcher.ts",
  "packages/zelavis/src/db/database-service.ts",
  "packages/zelavis/src/db/engines/libsql-remote.ts",
  "packages/zelavis/src/db/engines/libsql.ts",
  "packages/zelavis/src/db/engines/lmdb.ts",
  "packages/zelavis/src/db/engines/node-sqlite.ts",
  "packages/zelavis/src/db/engines/rocksdb-js.ts",
  "packages/zelavis/src/db/node-host.ts",
  "packages/zelavis/src/db/spatial.ts",
  "packages/zelavis/src/db/vectors.ts",
  "packages/zelavis/src/domain-binding.ts",
  "packages/zelavis/src/domain-verifier.ts",
  "packages/zelavis/src/edge/acme-client.ts",
  "packages/zelavis/src/edge/certificates.ts",
  "packages/zelavis/src/edge/index.ts",
  "packages/zelavis/src/edge/onboarding.ts",
  "packages/zelavis/src/edge/routes.ts",
  "packages/zelavis/src/edge/traefik-compiler.ts",
  "packages/zelavis/src/index.ts",
  "packages/zelavis/src/platform/app-data-placement.ts",
  "packages/zelavis/src/platform/assistant-project-reader.ts",
  "packages/zelavis/src/platform/auth-bootstrap.ts",
  "packages/zelavis/src/platform/auth-repositories.ts",
  "packages/zelavis/src/platform/frontend-host.ts",
  "packages/zelavis/src/platform/gateway-authority.ts",
  "packages/zelavis/src/platform/host-operations.ts",
  "packages/zelavis/src/platform/host-package-provisioning.ts",
  "packages/zelavis/src/platform/master-secret.ts",
  "packages/zelavis/src/platform/project-frontend.ts",
  "packages/zelavis/src/platform/project-gateway.ts",
  "packages/zelavis/src/platform/project-placement-authority.ts",
  "packages/zelavis/src/platform/public-domain-forwarder.ts",
  "packages/zelavis/src/platform/service-store.ts",
  "packages/zelavis/src/platform/settings.ts",
  "packages/zelavis/src/platform/storage.ts",
  "packages/zelavis/src/runtimes/node.ts",
  "packages/zelavis/src/sdk/create-api.ts",
  "packages/zelavis/src/sdk/fetch.ts",
  "packages/zelavis/src/sdk/plugins.ts",
  "packages/zelavis/src/sdk/service-page.ts",
  "packages/zelavis/src/service-app.ts",
  "packages/zelavis/src/service.ts",
  "packages/zelavis/src/storage/conditions.ts",
  "packages/zelavis/src/storage/s3.ts",
  "packages/zelavis/src/tls.ts",
]);

/** Fingerprints ignore formatting and comments, but bind the containing function and actual syntax. */
export function scanEffectUsage(source, file = "source.ts") {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"], tokens: true });
  const findings = [];
  const syntax = node => ast.tokens.filter(token => token.start >= node.start && token.end <= node.end && typeof token.type === "object")
    .map(token => source.slice(token.start, token.end)).join("\0");
  const add = (node, kind, owner) => findings.push({ file, kind, owner, line: node.loc.start.line,
    fingerprint: createHash("sha256").update(`${kind}\0${owner}\0${syntax(node)}`).digest("hex") });
  function visit(node, owner = "module", asyncOwner = false, parent, grandparent, ancestors = []) {
    if (!node || typeof node !== "object") return;
    const isFunction = /Function|Method/.test(node.type) && (node.body || node.type === "ArrowFunctionExpression");
    const binding = node.type === "VariableDeclarator" ? node.id?.name : node.type === "ObjectProperty" ? node.key?.name ?? node.key?.value : undefined;
    // Effect.gen's synchronous generator is implementation scaffolding, not a
    // new operation owner. Keep unchanged nested callbacks bound to their
    // original operation; their own syntax and occurrence count still decide
    // whether a baseline entry applies.
    const effectGenerator = isFunction && node.generator && !node.async && parent?.type === "CallExpression" &&
      parent.callee.type === "MemberExpression" && parent.callee.object.type === "Identifier" &&
      parent.callee.object.name === "Effect" && parent.callee.property.name === "gen" &&
      grandparent?.type === "CallExpression" && grandparent.callee.type === "Identifier" && grandparent.callee.name === "present";
    // Traced immediate programs preserve an existing protocol operation owner.
    // The span must match that owner and the program must be presented directly;
    // nested legacy syntax and occurrence counts remain fully checked.
    const pipe = ancestors.at(-3);
    const presentation = ancestors.at(-4);
    const protocolGenerator = isFunction && node.generator && !node.async &&
      parent?.type === "CallExpression" && parent.callee.object?.name === "Effect" && parent.callee.property?.name === "gen" &&
      grandparent?.type === "MemberExpression" && grandparent.object === parent && grandparent.property.name === "pipe" &&
      pipe?.type === "CallExpression" && pipe.arguments.length === 1 &&
      pipe.arguments[0].callee?.object?.name === "Effect" && pipe.arguments[0].callee?.property?.name === "withSpan" &&
      pipe.arguments[0].arguments[0]?.value === owner.replace(/^module\//, "") &&
      presentation?.type === "CallExpression" && presentation.callee.name === "presentProtocol" && presentation.arguments[0] === pipe;
    const currentOwner = effectGenerator || protocolGenerator ? owner : binding ? `${owner}/${binding}` : isFunction ? `${owner}/${node.id?.name ?? node.key?.name ?? node.key?.value ?? "callback"}` : owner;
    if (isFunction && node.async) add(node, "async-function", currentOwner);
    if (node.type === "AwaitExpression" && !asyncOwner) add(node, "await", owner);
    if (node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Promise") add(node, "promise-constructor", owner);
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.object.type === "Identifier" && node.callee.object.name === "Promise" && ["all", "allSettled", "any", "race"].includes(node.callee.property.name)) add(node, "promise-coordination", owner);
    for (const [key, value] of Object.entries(node)) {
      if (["loc", "start", "end", "tokens", "comments"].includes(key)) continue;
      if (Array.isArray(value)) for (const child of value) { if (child?.type) visit(child, currentOwner, isFunction ? node.async : asyncOwner, node, parent, [...ancestors, node]); }
      else if (value?.type) visit(value, currentOwner, isFunction ? node.async : asyncOwner, node, parent, [...ancestors, node]);
    }
  }
  visit(ast.program);
  return findings;
}

export function violations(findings, baseline, strict = migratedFiles) {
  const allowed = new Map();
  for (const entry of baseline) { const key = `${entry.file}:${entry.fingerprint}`; allowed.set(key, (allowed.get(key) ?? 0) + 1); }
  return findings.filter(entry => {
    if (strict.has(entry.file)) return true;
    const key = `${entry.file}:${entry.fingerprint}`, remaining = allowed.get(key) ?? 0;
    if (!remaining) return true;
    allowed.set(key, remaining - 1);
    return false;
  });
}

async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(path);
  }
  return files;
}

export async function inventory() {
  const files = await sources(join(root, "packages/zelavis/src"));
  for (const service of ["zelavis-app", "zelavis-auth", "zelavis-marketplace"]) files.push(...await sources(join(root, "packages/zelavis/services", service, "src")));
  files.push(join(root, "zelavis-services/wordpress/src/runtime.ts"));
  return (await Promise.all(files.sort().map(async path => scanEffectUsage(await readFile(path, "utf8"), relative(root, path))))).flat();
}

async function main() {
  const findings = await inventory();
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const problems = violations(findings, baseline.entries);
  if (problems.length) {
    console.error("Effect v4 is mandatory for new or changed Platform orchestration:");
    for (const entry of problems) console.error(`  ${entry.file}:${entry.line} ${entry.kind} in ${entry.owner}`);
    console.error("Use Effect.fn/gen, Deferred/Semaphore, bounded Effect.forEach, and scoped finalizers. Promise APIs belong at integration boundaries. The baseline cannot authorize new orchestration.");
    process.exitCode = 1;
    return;
  }
  if (process.argv.includes("--prune-baseline")) {
    const live = new Set(findings.map(entry => `${entry.file}:${entry.fingerprint}`));
    baseline.entries = baseline.entries.filter(entry => live.has(`${entry.file}:${entry.fingerprint}`));
    await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  }
  console.log(`Effect usage check passed; ${findings.length} recorded legacy occurrences remain outside migrated lifecycle files.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
