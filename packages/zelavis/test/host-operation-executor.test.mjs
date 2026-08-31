import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeHostOperationExecutor } from "../dist/adapters/_node-host-operation-executor.js";

test("Node host operation executor verifies authority, manifest digest, arguments, and idempotency", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-host-operation-"));
  const file = join(directory, "verify.sh");
  const body = "#!/bin/sh\nset -eu\n[ \"$1\" = \"--project\" ]\nprintf 'verified:%s\\n' \"$2\"\n";
  await writeFile(file, body, { mode: 0o700 });
  await chmod(file, 0o700);
  const sha256 = createHash("sha256").update(body).digest("hex");

  try {
    const executor = await createNodeHostOperationExecutor({
      rootDirectory: directory,
      operations: [{
        file: "verify.sh",
        manifest: {
          id: "native.verify",
          version: "v1",
          sha256,
          arguments: {
            project: { required: true, pattern: "^[a-z0-9-]+$", maxLength: 64 },
          },
        },
      }],
      authorize: async (request) => request.authority === "signed-test-authority",
    });
    const request = {
      operationId: "operation_0123456789abcdef",
      operation: "native.verify",
      version: "v1",
      artifactDigest: sha256,
      authority: "signed-test-authority",
      arguments: { project: "wordpress-a" },
      deadline: new Date(Date.now() + 30_000).toISOString(),
      projectId: "wordpress-a",
    };

    const first = await executor.execute(request);
    const replay = await executor.execute(request);
    assert.equal(first.status, "succeeded");
    assert.equal(first.stdout, "verified:wordpress-a\n");
    assert.deepEqual(replay, first);
    await assert.rejects(
      executor.execute({ ...request, operationId: "operation_abcdef0123456789", authority: "rejected" }),
      /authority was rejected/,
    );
    await assert.rejects(
      executor.execute({
        ...request,
        operationId: "operation_fedcba9876543210",
        arguments: { project: "wordpress-a", unexpected: "value" },
      }),
      /undeclared argument/,
    );
    await writeFile(file, `${body}\n# changed`, { mode: 0o700 });
    await assert.rejects(
      executor.execute({ ...request, operationId: "operation_1111222233334444" }),
      /changed after registration/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
