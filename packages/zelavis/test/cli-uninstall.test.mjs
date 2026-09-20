import assert from "node:assert/strict";
import test from "node:test";

import {
  ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
} from "../dist/core/runtime/installation.js";
import { runCli } from "../dist/cli/index.js";

const plan = {
  adapter: "test",
  installation: {
    kind: "packaged",
    path: "/opt/zelavis/current/platform/dist/cli.js",
    root: "/opt/zelavis",
  },
  dataDirectory: "/var/lib/zelavis",
  targets: [
    {
      id: "data",
      kind: "directory",
      description: "Remove Platform data.",
      path: "/var/lib/zelavis",
      exists: true,
    },
  ],
  retained: ["shared packages"],
};

async function capture(args, runtime) {
  const output = [];
  const errors = [];
  const log = console.log;
  const error = console.error;
  const previousExitCode = process.exitCode;
  console.log = (value) => output.push(String(value));
  console.error = (value) => errors.push(String(value));
  process.exitCode = undefined;
  try {
    await runCli(args, { runtime });
    return {
      output,
      errors,
      exitCode: process.exitCode ?? 0,
    };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = previousExitCode;
  }
}

function runtime(calls) {
  return {
    async serve() {},
    createInstallationUninstaller(options) {
      calls.push({ action: "create", options });
      return {
        async plan() {
          calls.push({ action: "plan" });
          return plan;
        },
        async uninstall(input) {
          calls.push({ action: "uninstall", input });
          return { removed: true, plan, output: "removed" };
        },
      };
    },
  };
}

test("CLI complete uninstall dry-run is inspectable and non-destructive", async () => {
  const calls = [];
  const result = await capture(
    ["uninstall", "--all", "--dry-run", "--data-dir", "/srv/zelavis"],
    runtime(calls),
  );
  assert.equal(result.exitCode, 0);
  assert.match(result.output.join("\n"), /No changes were made/u);
  assert.deepEqual(calls, [
    { action: "create", options: { dataDirectory: "/srv/zelavis" } },
    { action: "plan" },
  ]);
});

test("CLI requires both complete scope and the exact acknowledgement", async () => {
  const noScope = await capture(["uninstall", "--dry-run"], runtime([]));
  assert.equal(noScope.exitCode, 1);
  assert.match(noScope.errors.join("\n"), /requires --all/u);

  const calls = [];
  const noConfirmation = await capture(["uninstall", "--all"], runtime(calls));
  assert.equal(noConfirmation.exitCode, 1);
  assert.match(noConfirmation.errors.join("\n"), /requires --confirm/u);
  assert.equal(calls.some((call) => call.action === "uninstall"), false);
});

test("CLI invokes the local adapter and supports machine-readable output", async () => {
  const calls = [];
  const result = await capture(
    [
      "uninstall",
      "--all",
      "--confirm",
      ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION,
      "--json",
    ],
    runtime(calls),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.output.join("\n")).removed, true);
  assert.deepEqual(calls.at(-1), {
    action: "uninstall",
    input: { confirmation: ZELAVIS_COMPLETE_UNINSTALL_CONFIRMATION },
  });
});
