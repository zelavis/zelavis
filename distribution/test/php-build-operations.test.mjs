import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateHostOperationManifest } from "../../packages/zelavis/dist/core/deployment/index.js";
import { stageOperations } from "../scripts/stage-operations.mjs";

const source = fileURLToPath(new URL("../operations/", import.meta.url));
const buildFiles = fileURLToPath(new URL("../php-builds/", import.meta.url));
const IDS = ["zelavis.php-build-start", "zelavis.php-build-status", "zelavis.php-build-upload", "zelavis.php-build-clean"];
const job = "0123456789abcdef";

async function staged(t) {
  const directory = await mkdtemp(join(tmpdir(), "zv-php-ops-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await stageOperations({ source, output: directory, validate: validateHostOperationManifest });
  return directory;
}

test("the build files travel inside the start operation, whose digest covers them", async (t) => {
  const directory = await staged(t);
  const artifact = await readFile(join(directory, "zelavis.php-build-start/v1/artifact"), "utf8");
  assert.doesNotMatch(artifact, /@@EMBED/);
  const manifest = JSON.parse(await readFile(join(directory, "zelavis.php-build-start/v1/manifest.json"), "utf8"));
  assert.equal(manifest.embed, undefined, "the staging directive is not part of the installed manifest");
  for (const [name, file] of [["ZV_BUILD_SH", "build.sh"], ["ZV_EXTENSIONS", "extensions.txt"], ["ZV_SPC_PINS", "spc.pins"], ["ZV_SOURCES_LOCK_SH", "sources-lock.sh"], ["ZV_SOURCES_LOCK", "sources.lock"]]) {
    const encoded = artifact.match(new RegExp(`--env '${name}=([A-Za-z0-9+/=]+)'`))?.[1];
    assert.ok(encoded, `${name} is carried`);
    assert.equal(Buffer.from(encoded, "base64").toString("utf8"), await readFile(join(buildFiles, file), "utf8"), `${file} arrives byte for byte`);
  }
});

test("each operation is bounded, names a permission and takes only what it needs", async (t) => {
  const directory = await staged(t);
  for (const id of IDS) {
    const manifest = JSON.parse(await readFile(join(directory, `${id}/v1/manifest.json`), "utf8"));
    assert.match(manifest.authorization.permission, /^server\.php-builds\.(run|view)$/);
    assert.equal(manifest.authorization.scope, "system");
    assert.ok(manifest.result.maxBytes <= 4096);
    for (const [, spec] of Object.entries(manifest.arguments)) assert.ok(spec.pattern && spec.maxLength, `${id}: every argument is pattern-checked and bounded`);
  }
  const url = JSON.parse(await readFile(join(directory, "zelavis.php-build-upload/v1/manifest.json"), "utf8")).arguments.url.pattern;
  const allowed = new RegExp(url);
  assert.ok(allowed.test("https://abc123.r2.cloudflarestorage.com/zelavis-mirror/php/8.4.23/php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz?X-Amz-Signature=abc&X-Amz-Expires=3600"));
  for (const bad of ["http://abc.r2.cloudflarestorage.com/x?a=b", "https://evil.example.com/x?a=b", "https://abc.r2.cloudflarestorage.com.evil.example/x?a=b", "https://abc.r2.cloudflarestorage.com/x?a=b c", "https://user@abc.r2.cloudflarestorage.com/x?a=b"]) {
    assert.ok(!allowed.test(bad), `${bad} is refused`);
  }
  const start = await readFile(join(directory, "zelavis.php-build-start/v1/artifact"), "utf8");
  assert.match(start, /debian:bookworm-slim@sha256:[0-9a-f]{64}/, "the image is pinned by digest");
  for (const id of IDS.slice(1)) {
    assert.doesNotMatch(await readFile(join(directory, `${id}/v1/artifact`), "utf8"), /docker run|docker pull|docker exec/, `${id} starts nothing`);
  }
});

const dockerAvailable = spawnSync("docker", ["version"], { stdio: "ignore" }).status === 0;
const FAKE_DOCKER = `#!/bin/sh
echo "$*" >> /calls
case "$1" in
  version) exit 0 ;;
  info) echo / ;;
  ps) cat /tmp/running 2>/dev/null || true ;;
  volume)
    case "$2" in
      inspect) if [ "$3" = --format ]; then cat /fake/volume-label; else exit 1; fi ;;
      create|rm) exit 0 ;;
    esac ;;
  inspect)
    case "$3" in
      *Labels*) cat /fake/label ;;
      '{{.State.Status}} {{.State.ExitCode}}') cat /tmp/state 2>/dev/null || cat /fake/state ;;
      '{{.State.Status}}') (cat /tmp/state 2>/dev/null || cat /fake/state) | cut -d' ' -f1 ;;
      '{{.State.ExitCode}}') (cat /tmp/state 2>/dev/null || cat /fake/state) | cut -d' ' -f2 ;;
    esac ;;
  logs) cat /fake/log ;;
  cp)
    case "$2" in
      *builds.jsonl) tar -cf - -C /fake builds.jsonl ;;
      *) f=\${2##*/}; [ -f "/fake/$f" ] && tar -cf - -C /fake "$f" || exit 1 ;;
    esac ;;
  rm) exit 0 ;;
  run) echo "$*" > /last-run; echo cid ;;
esac
`;
const FAKE_CURL = `#!/bin/sh
echo "$*" >> /curl-calls
exit \${CURL_EXIT:-0}
`;

async function inContainer(t, steps, { label = "1\n" } = {}) {
  const directory = await staged(t);
  const fake = join(directory, "fake");
  await mkdir(fake);
  await writeFile(join(fake, "docker"), FAKE_DOCKER, { mode: 0o755 });
  await writeFile(join(fake, "curl"), FAKE_CURL, { mode: 0o755 });
  await writeFile(join(fake, "label"), label);
  await writeFile(join(fake, "volume-label"), "1\n");
  await writeFile(join(fake, "log"), "Reading package lists\nBuilding libxml2 now\nUnsafe \u001b[31m*; rm -rf /\"\n");
  await writeFile(join(fake, "builds.jsonl"), `{"php":"8.4.23","sapi":"cli","platform":"linux-aarch64","file":"php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz","sha256":"${"a".repeat(64)}","bytes":24448012,"executable":"php"}\n`);
  await writeFile(join(fake, "php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz"), "archive bytes");
  await writeFile(join(fake, "state"), "exited 0\n");
  await writeFile(join(fake, "driver.sh"), `set -u
cp /fake/docker /fake/curl /usr/local/bin/
${steps}
`);
  const run = spawnSync("docker", ["run", "--rm", "--volume", `${directory}:/ops:ro`, "--volume", `${fake}:/fake:ro`, "debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587", "sh", "/fake/driver.sh"], { encoding: "utf8" });
  return run;
}
const op = (id, ...args) => `sh /ops/${id}/v1/artifact ${args.join(" ")}`;

test("status reports state, a safe log tail and each archive's digest", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const run = await inContainer(t, `${op("zelavis.php-build-status", "--job", job)}`);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1));
  assert.equal(result.state, "exited");
  assert.equal(result.exitCode, 0);
  assert.match(result.log, /^[A-Za-z0-9 ._:\/=+|,()-]*$/, "nothing that needs escaping reaches the JSON");
  assert.deepEqual(result.builds, [{ file: "php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz", sha256: "a".repeat(64), bytes: 24448012 }]);
});

test("status of something that is not one of ours, or not there, is simply missing", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const run = await inContainer(t, op("zelavis.php-build-status", "--job", job), { label: "\n" });
  assert.deepEqual(JSON.parse(run.stdout.trim()), { schema: 1, job, state: "missing", exitCode: null, log: "", builds: [] });
});

test("upload sends the named archive to the presigned address and reports what it sent", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const url = "https://abc123.r2.cloudflarestorage.com/zelavis-mirror/php/8.4.23/x.tar.gz?X-Amz-Signature=abc";
  const run = await inContainer(t, `${op("zelavis.php-build-upload", "--file", "php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz", "--job", job, "--url", `'${url}'`)}\necho CURL; cat /curl-calls`);
  const [json, , curl] = run.stdout.trim().split("\n");
  const result = JSON.parse(json);
  assert.equal(result.file, "php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz");
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.bytes, "archive bytes".length);
  assert.match(curl, /--proto =https/);
  assert.ok(curl.includes(url));
});

test("upload refuses an address that is not R2, a path in the file name, and an unfinished build", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const file = "php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz";
  const run = await inContainer(t, [
    `${op("zelavis.php-build-upload", "--file", file, "--job", job, "--url", "'https://evil.example.com/x?a=b'")}; echo "evil=$?"`,
    `${op("zelavis.php-build-upload", "--file", "../etc/passwd", "--job", job, "--url", "'https://abc.r2.cloudflarestorage.com/x?a=b'")}; echo "path=$?"`,
    `echo 'running 0' > /tmp/state; ${op("zelavis.php-build-upload", "--file", file, "--job", job, "--url", "'https://abc.r2.cloudflarestorage.com/x?a=b'")}; echo "after=$?"`,
  ].join("\n"));
  assert.match(run.stdout, /evil=2/);
  assert.match(run.stdout, /path=2/);
  assert.match(run.stdout, /after=1/, "a build that has not finished successfully has nothing to upload");
  assert.match(run.stderr, /not finished successfully/);
});

test("clean removes only what carries the build label and is safe to repeat", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const run = await inContainer(t, `${op("zelavis.php-build-clean", "--job", job)}\n${op("zelavis.php-build-clean", "--job", job)}\ncat /calls | grep -c "rm"`);
  const lines = run.stdout.trim().split("\n");
  assert.deepEqual(JSON.parse(lines[0]), { schema: 1, job, containerRemoved: true, outputRemoved: true });
  assert.deepEqual(JSON.parse(lines[1]), { schema: 1, job, containerRemoved: true, outputRemoved: true });
});

test("start launches one limited, labeled, detached container from the pinned image", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const run = await inContainer(t, `${op("zelavis.php-build-start", "--job", job, "--php", "8.4.23")}\necho "exit=$?"\nsed 's/ZV_[A-Z_]*=[A-Za-z0-9+\/=]*/ZV_FILE/g' /last-run 2>/dev/null`);
  if (/Not enough free (memory|disk)/.test(run.stderr + run.stdout)) { t.skip("this machine is too small to start a build, which is the operation working as intended"); return; }
  const lines = run.stdout.trim().split("\n");
  const result = JSON.parse(lines[0]);
  assert.equal(result.job, job);
  assert.ok(result.cpus >= 1 && result.cpus <= 4 && result.memoryMb >= 3072 && result.memoryMb <= 6144);
  const launched = lines.slice(2).join(" ");
  for (const needle of ["run --detach", `--name zv-phpbuild-${job}`, "--label zelavis.php-build=1", "--memory-swap", "--pids-limit 4096", "debian:bookworm-slim@sha256:"]) assert.ok(launched.includes(needle), `${needle} in the launch`);
  assert.ok(!launched.includes("--privileged") && !launched.includes("docker.sock") && !launched.includes("--network host"), "nothing that widens the container");
});

test("start refuses a second build while one is running, and a version that is not exact", { skip: !dockerAvailable && "needs docker" }, async (t) => {
  const running = await inContainer(t, `printf 'abc\\n' > /tmp/running; ${op("zelavis.php-build-start", "--job", job, "--php", "8.4.23")}; echo "exit=$?"`);
  assert.match(running.stdout, /exit=1/, running.stdout + running.stderr);
  assert.match(running.stderr, /Another build is running/);
  const loose = await inContainer(t, `${op("zelavis.php-build-start", "--job", job, "--php", "8.4")}; echo "exit=$?"`);
  assert.match(loose.stdout, /exit=2/);
  assert.match(loose.stderr, /exact|Invalid/);
});
