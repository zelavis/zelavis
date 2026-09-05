import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readScaffoldOutput,
  resolveCreatePackageBin,
  runCreatePackage,
} from "../dist/adapters/_package-scaffold.js";
import { createMemorySystemStore, zelavis } from "../dist/index.js";

const PLATFORM_OWNER_CONTEXT = {
  principal: {
    id: "test-owner",
    type: "user",
    roles: ["owner"],
    permissions: ["*"],
  },
};

async function scaffoldRun(binSource) {
  const root = await mkdtemp(join(tmpdir(), "zelavis-scaffold-"));
  const packageDirectory = join(root, "create");
  const runDirectory = join(root, "run");
  const outputDirectory = join(runDirectory, "out");

  await mkdir(packageDirectory, { recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "bin.mjs"), binSource, "utf8");

  return { root, packageDirectory, runDirectory, outputDirectory };
}

test("a create package's declared command is resolved, and an ambiguous one is refused", () => {
  assert.equal(
    resolveCreatePackageBin({ name: "create-thing", bin: "./bin/cli.js" }),
    "bin/cli.js",
  );
  assert.equal(
    resolveCreatePackageBin({ name: "create-thing", bin: { "create-thing": "cli.js" } }),
    "cli.js",
  );

  // Two commands and no choice named: guessing which one scaffolds a project
  // is how a run silently produces the wrong thing.
  assert.throws(
    () =>
      resolveCreatePackageBin({
        name: "create-thing",
        bin: { init: "a.js", eject: "b.js" },
      }),
    /more than one command/,
  );

  assert.throws(
    () => resolveCreatePackageBin({ name: "create-thing" }),
    /declares no "bin"/,
  );

  // A command pointing outside its own package is the whole reason this is
  // validated rather than joined onto the package directory.
  assert.throws(
    () => resolveCreatePackageBin({ name: "create-thing", bin: "../../etc/passwd" }),
    /outside its own package/,
  );
});

test("a create package writes its scaffold into the working directory", async () => {
  const paths = await scaffoldRun(`
    import { writeFile, mkdir } from "node:fs/promises";
    await mkdir("src", { recursive: true });
    await writeFile("package.json", JSON.stringify({ name: "@acme/site" }));
    await writeFile("src/index.js", "export default 1;");
  `);

  await runCreatePackage({
    packageDirectory: paths.packageDirectory,
    binPath: "bin.mjs",
    outputDirectory: paths.outputDirectory,
    runDirectory: paths.runDirectory,
  });

  const entries = await readScaffoldOutput(paths.outputDirectory);
  assert.deepEqual(
    entries.map((entry) => entry.path).sort(),
    ["package.json", "src/index.js"],
  );
});

test("the create package runs with no network", async () => {
  // The point of not being `npx`: a create package that fetches its template
  // at run time routes around the source policy, so it must fail rather than
  // quietly succeed.
  const paths = await scaffoldRun(`
    import { writeFile } from "node:fs/promises";
    const attempts = [];
    for (const [label, run] of [
      ["fetch", () => fetch("https://registry.npmjs.org/")],
      ["net", async () => (await import("node:net")).connect(443, "registry.npmjs.org")],
      ["https", async () => (await import("node:https")).get("https://registry.npmjs.org/")],
      ["dns", async () => (await import("node:dns")).lookup("registry.npmjs.org", () => {})],
      // A named import binds against the built-in's ESM namespace, which is
      // snapshotted on first import — patching the exports object afterwards
      // would leave this one reaching the real function.
      ["named", async () => { const { connect } = await import("node:net"); connect(443, "registry.npmjs.org"); }],
      ["require", async () => {
        const { createRequire } = await import("node:module");
        createRequire(import.meta.url)("node:https").get("https://registry.npmjs.org/");
      }],
    ]) {
      try { await run(); attempts.push(label + ":reached"); }
      catch (error) { attempts.push(label + ":" + (error.message.includes("disabled") ? "denied" : "other")); }
    }
    await writeFile("package.json", JSON.stringify({ attempts }));
  `);

  await runCreatePackage({
    packageDirectory: paths.packageDirectory,
    binPath: "bin.mjs",
    outputDirectory: paths.outputDirectory,
    runDirectory: paths.runDirectory,
  });

  const written = JSON.parse(
    await readFile(join(paths.outputDirectory, "package.json"), "utf8"),
  );
  assert.deepEqual(written.attempts, [
    "fetch:denied",
    "net:denied",
    "https:denied",
    "dns:denied",
    "named:denied",
    "require:denied",
  ]);
});

test("the create package cannot spawn its way back to the network", async () => {
  // Closing the module layer alone would be theatre if the package could start
  // curl, so the permission model has to deny process spawning for the network
  // claim above to mean anything.
  const paths = await scaffoldRun(`
    import { writeFile } from "node:fs/promises";
    let result;
    try {
      const { execSync } = await import("node:child_process");
      execSync("echo reached");
      result = "spawned";
    } catch (error) {
      result = error.code ?? "denied";
    }
    await writeFile("package.json", JSON.stringify({ result }));
  `);

  await runCreatePackage({
    packageDirectory: paths.packageDirectory,
    binPath: "bin.mjs",
    outputDirectory: paths.outputDirectory,
    runDirectory: paths.runDirectory,
  });

  const written = JSON.parse(
    await readFile(join(paths.outputDirectory, "package.json"), "utf8"),
  );
  assert.equal(written.result, "ERR_ACCESS_DENIED");
});

test("the create package cannot write outside the directory it was given", async () => {
  const paths = await scaffoldRun(`
    import { writeFile } from "node:fs/promises";
    let escaped;
    try {
      await writeFile(new URL("../escaped.txt", import.meta.url).pathname, "x");
      escaped = "wrote";
    } catch (error) {
      escaped = error.code ?? "denied";
    }
    await writeFile("package.json", JSON.stringify({ escaped }));
  `);

  await runCreatePackage({
    packageDirectory: paths.packageDirectory,
    binPath: "bin.mjs",
    outputDirectory: paths.outputDirectory,
    runDirectory: paths.runDirectory,
  });

  const written = JSON.parse(
    await readFile(join(paths.outputDirectory, "package.json"), "utf8"),
  );
  assert.equal(written.escaped, "ERR_ACCESS_DENIED");
});

test("a create package that fails is reported with what it printed", async () => {
  const paths = await scaffoldRun(`
    console.error("no template for that framework");
    process.exit(3);
  `);

  await assert.rejects(
    runCreatePackage({
      packageDirectory: paths.packageDirectory,
      binPath: "bin.mjs",
      outputDirectory: paths.outputDirectory,
      runDirectory: paths.runDirectory,
    }),
    /exited with code 3[\s\S]*no template for that framework/,
  );
});

test("a run that wrote nothing is not registered as a package", async () => {
  const paths = await scaffoldRun(`console.log("done");`);

  await runCreatePackage({
    packageDirectory: paths.packageDirectory,
    binPath: "bin.mjs",
    outputDirectory: paths.outputDirectory,
    runDirectory: paths.runDirectory,
  });

  await assert.rejects(
    readScaffoldOutput(paths.outputDirectory),
    /wrote nothing/,
  );
});

test("scaffolding registers the produced package like any other install", async () => {
  let received;
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { auth: false, database: false },
    servicePackageInstaller: {
      install: () => {
        throw new Error("not used");
      },
      scaffold: (input) => {
        received = input;
        return {
          specifier: "data:text/javascript,export default { name: '@acme/site' }",
          resolved: "npm:create-zelavis-frontend@1.0.0",
          integrity: "sha512-test",
        };
      },
    },
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "@acme/site",
        scaffoldFrom: "npm:create-zelavis-frontend@1.0.0",
        scaffoldCommand: "create-zelavis-frontend",
        scaffoldArgs: ["--template", "blog"],
        status: "installed",
      }),
    }),
    PLATFORM_OWNER_CONTEXT,
  );

  assert.equal(response.status, 201, await response.text());
  assert.deepEqual(received, {
    reference: "npm:create-zelavis-frontend@1.0.0",
    command: "create-zelavis-frontend",
    args: ["--template", "blog"],
  });
});

test("an installation without a scaffolder says so instead of failing obscurely", async () => {
  const runtime = await zelavis({
    systemStore: createMemorySystemStore(),
    subsystems: { auth: false, database: false },
  });

  const response = await runtime.fetch(
    new Request("http://localhost/zelavis/api/v1/runtime/services", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scaffoldFrom: "npm:create-zelavis-frontend@1.0.0",
        status: "installed",
      }),
    }),
    PLATFORM_OWNER_CONTEXT,
  );

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /cannot scaffold a frontend/);
});
