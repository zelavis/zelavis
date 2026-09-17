import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBuiltinDeploymentBackends,
  createDockerDeploymentBackend,
  createNativeDeploymentBackend,
} from "zelavis/backends";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const IMPORT_PATTERN = /(?:^|[\s;])(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^import\s*["']([^"']+)["']/gm;

/** Static relative import closure of one built module. */
async function importClosure(entry) {
  const seen = new Set();
  const external = new Map();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (specifier.startsWith(".")) {
        pending.push(resolve(dirname(file), specifier));
      } else {
        external.set(specifier, file);
      }
    }
  }
  return { files: seen, external };
}

test("zelavis/backends reaches no Node built-in or host adapter module", async () => {
  const { files, external } = await importClosure(resolve(dist, "backends/index.js"));
  const nodeImports = [...external].filter(([specifier]) =>
    specifier.startsWith("node:"),
  );
  assert.deepEqual(nodeImports, []);
  const adapterFiles = [...files].filter((file) => file.includes("/adapters/"));
  assert.deepEqual(adapterFiles, []);
});

function fakeHost({ platform = "linux", paths = [], files = {}, commands = {} } = {}) {
  const calls = [];
  return {
    calls,
    host: {
      platform,
      async pathExists(path) {
        calls.push(`exists:${path}`);
        return paths.includes(path);
      },
      async readTextFile(path) {
        calls.push(`read:${path}`);
        return files[path];
      },
      async runProbeCommand(executable, args) {
        calls.push(`run:${executable} ${args.join(" ")}`);
        return commands[`${executable} ${args[0]}`] ??
          { code: 1, stdout: "", stderr: "", missing: true, timedOut: false };
      },
    },
  };
}

test("native detection reads only the injected host probes", async () => {
  const linux = fakeHost({
    paths: ["/sys/fs/cgroup/cgroup.controllers"],
    files: { "/proc/sys/user/max_user_namespaces": "15000\n" },
  });
  const detection = await createNativeDeploymentBackend({ host: linux.host }).detect();
  assert.equal(detection.state, "ready");
  assert.deepEqual(
    { ...detection.details },
    {
      platform: "linux",
      cgroupV2: true,
      systemd: false,
      userNamespaces: true,
      isolationProfile: "legacy-process",
    },
  );

  const darwin = fakeHost({ platform: "darwin" });
  const other = await createNativeDeploymentBackend({ host: darwin.host }).detect();
  assert.equal(other.details.platform, "darwin");
  assert.equal(other.details.cgroupV2, false);
  // Linux-only facts are not probed on another host.
  assert.deepEqual(darwin.calls, []);
});

test("docker detection distinguishes missing, unreachable and ready engines", async () => {
  const missing = fakeHost();
  assert.equal(
    (await createDockerDeploymentBackend({ host: missing.host }).detect()).state,
    "unavailable",
  );

  const unreachable = fakeHost({
    commands: {
      "docker version": { code: 1, stdout: "", stderr: "Cannot connect", missing: false, timedOut: false },
    },
  });
  const degraded = await createDockerDeploymentBackend({ host: unreachable.host }).detect();
  assert.equal(degraded.state, "degraded");
  assert.equal(degraded.error, "Cannot connect");

  const ready = fakeHost({
    commands: {
      "docker version": {
        code: 0,
        stdout: JSON.stringify({ Server: { Version: "27.1.0", ApiVersion: "1.46", Os: "linux", Arch: "arm64" } }),
        stderr: "",
        missing: false,
        timedOut: false,
      },
      "docker info": { code: 0, stdout: JSON.stringify(["name=rootless"]), stderr: "", missing: false, timedOut: false },
    },
  });
  const detection = await createDockerDeploymentBackend({ host: ready.host }).detect();
  assert.equal(detection.state, "ready");
  assert.equal(detection.rootless, true);
  assert.equal(detection.version, "27.1.0");
});

test("built-in backend set detects through the supplied host probes", async () => {
  const { host, calls } = fakeHost({ platform: "darwin" });
  const backends = createBuiltinDeploymentBackends({ host });
  assert.deepEqual(backends.map((backend) => backend.id), ["native", "docker"]);
  await Promise.all(backends.map((backend) => backend.detect()));
  assert.deepEqual(calls, ["run:docker version --format {{json .}}"]);
});
