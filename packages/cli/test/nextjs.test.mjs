import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { bootstrapNextjs } from "../dist/nextjs.js";

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-cli-nextjs-"));
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
    "utf8",
  );
  return directory;
}

test("bootstrapNextjs creates App Router catch-all route", async () => {
  const directory = await createFixture();
  try {
    const result = await bootstrapNextjs({
      cwd: directory,
      adapter: "vercel",
      router: "app",
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.actions.map((action) => action.path),
      ["lib/zelavis.server.ts", "app/zelavis/[[...path]]/route.ts"],
    );

    const runtime = await readFile(
      join(directory, "lib/zelavis.server.ts"),
      "utf8",
    );
    assert.match(runtime, /vercelAdapter\(\)/);
    assert.match(runtime, /export const zelavis = new Zelavis/);

    const route = await readFile(
      join(directory, "app/zelavis/[[...path]]/route.ts"),
      "utf8",
    );
    assert.match(route, /export const runtime = "nodejs"/);
    assert.match(route, /zelavis\.fetch\(request\)/);
    assert.match(route, /export const DELETE = handle/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrapNextjs creates Pages Router API route and rewrite config", async () => {
  const directory = await createFixture();
  try {
    const result = await bootstrapNextjs({
      cwd: directory,
      adapter: "node",
      router: "pages",
    });

    assert.deepEqual(result.warnings, []);
    assert.deepEqual(
      result.actions.map((action) => action.path),
      [
        "lib/zelavis.ts",
        "pages/api/zelavis/[[...path]].ts",
        "next.config.ts",
      ],
    );

    const runtime = await readFile(join(directory, "lib/zelavis.ts"), "utf8");
    assert.match(runtime, /nodeAdapter\(\)/);

    const apiRoute = await readFile(
      join(directory, "pages/api/zelavis/[[...path]].ts"),
      "utf8",
    );
    assert.match(apiRoute, /nextjsPagesRouterHandler\(zelavis/);
    assert.match(apiRoute, /bodyParser: false/);

    const nextConfig = await readFile(join(directory, "next.config.ts"), "utf8");
    assert.match(nextConfig, /source: "\/zelavis\/:path\*"/);
    assert.match(nextConfig, /destination: "\/api\/zelavis\/:path\*"/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrapNextjs warns instead of rewriting custom Next config", async () => {
  const directory = await createFixture();
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "next.config.mjs"),
      "export default { reactStrictMode: true };\n",
      "utf8",
    );

    const result = await bootstrapNextjs({
      cwd: directory,
      adapter: "node",
      router: "pages",
    });

    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /Could not safely update next.config.mjs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
