import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalSqliteSystemStore } from "../dist/adapters/_sqlite-system-store.js";

const posix = process.platform !== "win32";

test(
  "the local System Store is readable only by its owner",
  { skip: posix ? false : "POSIX permissions only" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "zelavis-perms-"));
    const filename = join(directory, "state", "system.db");
    const store = createLocalSqliteSystemStore({ filename });

    try {
      await store.set("things", "a", { value: 1 });

      const fileMode = (await stat(filename)).mode & 0o777;
      assert.equal(
        fileMode,
        0o600,
        `expected 0600 on the store file, found 0${fileMode.toString(8)}`,
      );

      const directoryMode = (await stat(join(directory, "state"))).mode & 0o777;
      assert.equal(
        directoryMode,
        0o700,
        `expected 0700 on the store directory, found 0${directoryMode.toString(8)}`,
      );
    } finally {
      store.close?.();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("closing the local System Store is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-close-"));
  try {
    const store = createLocalSqliteSystemStore({
      filename: join(directory, "system.db"),
    });
    store.set("things", "a", { value: 1 });

    store.close?.();
    // A second close must not throw; shutdown paths may call it more than once.
    store.close?.();
    store.close?.();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repeatedly opening and closing stores does not retain handles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-handles-"));
  try {
    for (let index = 0; index < 25; index += 1) {
      const store = createLocalSqliteSystemStore({
        filename: join(directory, `system-${index}.db`),
      });
      store.set("things", "a", { value: index });
      assert.equal(store.get("things", "a").value.value, index);
      store.close?.();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
