import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { bootstrapReactRouter } from "../dist/react-router.js";

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-cli-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8",
  );
  await mkdir(join(directory, "app/routes"), { recursive: true });
  await mkdir(join(directory, "app/lib"), { recursive: true });
  return directory;
}

test("bootstrapReactRouter creates route, runtime module, and route config entry", async () => {
  const directory = await createFixture();
  try {
    await writeFile(
      join(directory, "app/routes.ts"),
      `import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/index.tsx"),
  route("*", "routes/$.tsx"),
] satisfies RouteConfig;
`,
      "utf8",
    );

    const result = await bootstrapReactRouter({
      cwd: directory,
      adapter: "node",
    });

    assert.deepEqual(result.warnings, []);
    assert.equal(result.mountPath, "/zelavis");
    assert.deepEqual(
      result.actions.map((action) => action.status),
      ["created", "created", "updated"],
    );

    const runtime = await readFile(
      join(directory, "app/lib/zelavis.server.ts"),
      "utf8",
    );
    assert.match(runtime, /nodeAdapter\(\)/);

    const route = await readFile(
      join(directory, "app/routes/zelavis.$.ts"),
      "utf8",
    );
    assert.match(route, /getZelavis\(\)\.fetch\(request\)/);

    const routeConfig = await readFile(join(directory, "app/routes.ts"), "utf8");
    assert.match(
      routeConfig,
      /route\("zelavis\/\*", "routes\/zelavis\.\$\.ts"\),\n  route\("\*", "routes\/\$\.tsx"\),/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrapReactRouter skips existing files and route entries", async () => {
  const directory = await createFixture();
  try {
    await writeFile(
      join(directory, "app/routes.ts"),
      `import { type RouteConfig, route } from "@react-router/dev/routes";

export default [
  route("zelavis/*", "routes/zelavis.$.ts"),
] satisfies RouteConfig;
`,
      "utf8",
    );
    await writeFile(join(directory, "app/lib/zelavis.server.ts"), "existing", "utf8");
    await writeFile(join(directory, "app/routes/zelavis.$.ts"), "existing", "utf8");

    const result = await bootstrapReactRouter({
      cwd: directory,
      adapter: "bun",
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.actions.map((action) => action.status),
      ["skipped", "skipped", "skipped"],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
