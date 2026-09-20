import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
  assertCompleteUninstallConfirmation,
} from "../dist/core/runtime/installation.js";
import { createNodeInstallationUninstaller } from "../dist/adapters/node.js";

test("complete uninstall uses one explicit, stable acknowledgement", () => {
  assert.doesNotThrow(() =>
    assertCompleteUninstallConfirmation(
      ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
    ),
  );
  assert.throws(
    () => assertCompleteUninstallConfirmation("yes"),
    /DELETE-ALL-ZELAVIS-DATA/u,
  );
});

test("the Node host adapter plans and invokes packaged removal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-uninstaller-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "installation");
  const dataDirectory = join(root, "data");
  const cliPath = join(prefix, "current", "platform", "dist", "cli.js");
  const scriptPath = join(prefix, "current", "share", "uninstall.sh");
  await mkdir(join(prefix, "current", "platform", "dist"), { recursive: true });
  await mkdir(join(prefix, "current", "share"), { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(cliPath, "", "utf8");
  await writeFile(
    scriptPath,
    "#!/bin/sh\nprintf 'removed:%s:%s:%s:%s:%s:%s\\n' \"$ZELAVIS_PREFIX\" \"$ZELAVIS_DATA_DIR\" \"$ZELAVIS_UNINSTALL_ETC_DIR\" \"$ZELAVIS_UNINSTALL_SKIP_HOST_COMMANDS\" \"$ZELAVIS_UNINSTALL_OWNS_USER\" \"$ZELAVIS_UNINSTALL_OWNS_GROUP\"\n",
    { encoding: "utf8", mode: 0o755 },
  );

  const uninstaller = createNodeInstallationUninstaller({
    installation: { kind: "packaged", path: cliPath, root: prefix },
    dataDirectory,
  });
  const plan = await uninstaller.plan();
  assert.equal(plan.installation.root, prefix);
  assert.equal(plan.dataDirectory, dataDirectory);
  assert.equal(
    plan.targets.find((target) => target.id === "data")?.exists,
    true,
  );
  await assert.rejects(
    uninstaller.uninstall({ confirmation: "yes" }),
    /DELETE-ALL-ZELAVIS-DATA/u,
  );

  const result = await uninstaller.uninstall({
    confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
  });
  assert.equal(result.removed, true);
  assert.equal(
    result.output,
    `removed:${prefix}:${dataDirectory}:/etc/zelavis:0:0:0`,
  );
});

test("the Node host adapter recovers customized paths from the installer receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-uninstaller-receipt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const prefix = join(root, "installation");
  const dataDirectory = join(root, "custom-data");
  const commandPath = join(root, "custom-bin", "zelavis");
  const cliPath = join(prefix, "current", "platform", "dist", "cli.js");
  const scriptPath = join(prefix, "current", "share", "uninstall.sh");
  await mkdir(join(prefix, "current", "platform", "dist"), { recursive: true });
  await mkdir(join(prefix, "current", "share"), { recursive: true });
  await mkdir(dataDirectory, { recursive: true });
  await writeFile(cliPath, "", "utf8");
  await writeFile(
    join(prefix, "installation.json"),
    JSON.stringify({
      schemaVersion: 1,
      dataDirectory,
      commandPath,
      ownsUser: true,
      ownsGroup: true,
    }),
  );
  await writeFile(
    scriptPath,
    "#!/bin/sh\nprintf '%s:%s:%s:%s\n' \"$ZELAVIS_DATA_DIR\" \"$ZELAVIS_UNINSTALL_COMMAND\" \"$ZELAVIS_UNINSTALL_OWNS_USER\" \"$ZELAVIS_UNINSTALL_OWNS_GROUP\"\n",
    { encoding: "utf8", mode: 0o755 },
  );

  const uninstaller = createNodeInstallationUninstaller({
    installation: { kind: "packaged", path: cliPath, root: prefix },
  });
  assert.equal((await uninstaller.plan()).dataDirectory, dataDirectory);
  const result = await uninstaller.uninstall({
    confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
  });
  assert.equal(result.output, `${dataDirectory}:${commandPath}:1:1`);
});

test("the Node host adapter refuses source and npm copies", () => {
  for (const kind of ["source", "npm"]) {
    assert.throws(
      () =>
        createNodeInstallationUninstaller({
          installation: {
            kind,
            path: `/tmp/${kind}/dist/cli.js`,
            root: `/tmp/${kind}`,
          },
          dataDirectory: `/tmp/${kind}-data`,
        }),
      /only to a packaged Zelavis installation/u,
    );
  }
});

test("the Node host adapter refuses broad roots and an external removal program", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-uninstaller-safety-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliPath = join(root, "current", "platform", "dist", "cli.js");
  await mkdir(join(root, "current", "platform", "dist"), { recursive: true });
  await mkdir(join(root, "current", "share"), { recursive: true });
  await writeFile(cliPath, "", "utf8");
  await writeFile(join(root, "current", "share", "uninstall.sh"), "#!/bin/sh\n");

  assert.throws(
    () =>
      createNodeInstallationUninstaller({
        installation: { kind: "packaged", path: "/opt/zelavis/cli.js", root: "/" },
        dataDirectory: join(root, "data"),
      }),
    /unsafe installation root/u,
  );
  await assert.rejects(
    createNodeInstallationUninstaller({
        installation: { kind: "packaged", path: cliPath, root },
        dataDirectory: "/tmp/project/..",
      }).plan(),
    /unsafe data directory/u,
  );
  assert.throws(
    () =>
      createNodeInstallationUninstaller({
        installation: { kind: "packaged", path: cliPath, root },
        dataDirectory: join(root, "data"),
        scriptPath: join(root, "..", "uninstall.sh"),
      }),
    /must be inside/u,
  );
});
