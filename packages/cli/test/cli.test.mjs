import assert from "node:assert/strict";
import { test } from "node:test";
import { runCli } from "../dist/index.js";

test("serve delegates to the injected Platform runtime", async () => {
  let received;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await runCli(
      ["serve", "--host", "0.0.0.0", "--port", "4100", "--data-dir", "/tmp/zelavis-data"],
      {
        runtime: {
          async serve(options) {
            received = options;
          },
        },
      },
    );

    assert.deepEqual(received, {
      host: "0.0.0.0",
      port: 4100,
      dataDirectory: "/tmp/zelavis-data",
    });
    assert.equal(process.exitCode, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("serve validates its listener port", async () => {
  const errors = [];
  const originalError = console.error;
  const previousExitCode = process.exitCode;
  console.error = (message) => errors.push(message);
  process.exitCode = undefined;

  try {
    await runCli(["serve", "--port", "0"], {
      runtime: { async serve() {} },
    });
    assert.equal(process.exitCode, 1);
    assert.match(errors[0], /between 1 and 65535/);
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
});
