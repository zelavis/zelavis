import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createLocalProjectRuntime } from "../dist/adapters/_local-project-runtime.js";
import {
  createLocalFrontendDirectoryResolver,
  createLocalRuntimeServicePackageInstaller,
} from "../dist/adapters/_local-runtime.js";
import { createProjectManager } from "../dist/project.js";
import { loadService } from "../dist/service.js";
import { createMemorySystemStore } from "../dist/system-store.js";

const FRONTEND_MANIFEST = {
  name: "@acme/theme",
  version: "2.1.0",
  type: "module",
  exports: { ".": { import: "./dist/index.js" } },
  zelavis: {
    kind: "frontend",
    frontend: { runtime: "server", start: ["node", "server.js"] },
  },
};

function driver() {
  const prepared = [];
  return {
    prepared,
    driver: {
      name: "test-driver",
      capabilities: () => ({
        independentRuntimeVersion: false,
        movable: false,
        liveMigration: false,
        secureIsolation: false,
        resourceLimits: false,
        persistentFilesystem: true,
        statelessRuntimeReplicas: false,
        managedStorage: false,
        managedDatabase: false,
        databaseReplication: false,
        tenantPlacement: false,
        databaseSharding: false,
        runtimeOwnership: "platform-process",
        survivesControlPlaneRestart: false,
        description: "test",
      }),
      async prepare(project) {
        prepared.push({ id: project.id, kind: project.kind });
      },
      async start() {
        return { status: "running", url: "http://127.0.0.1:1" };
      },
      async stop() {
        return { status: "stopped" };
      },
      async status() {
        return { status: "stopped" };
      },
      async logs() {
        return [];
      },
      async destroy() {},
      async close() {},
    },
  };
}

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-frontend-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("an installed frontend package becomes a runnable Project", async () => {
  await withDirectory(async (directory) => {
    const installer = createLocalRuntimeServicePackageInstaller({ directory });
    const installed = await installer.install({
      fileName: "theme.zip",
      body: await buildZip({
        "package.json": JSON.stringify(FRONTEND_MANIFEST),
        "dist/index.js": "export default {}",
        "server.js": "// started by the frontend runtime",
      }),
    });

    // A frontend package loads from its manifest without executing JavaScript.
    const service = await loadService(installed.specifier, {
      manifest: FRONTEND_MANIFEST,
    });
    assert.equal(service.kind, "frontend");

    const { driver: runtime, prepared } = driver();
    const projects = await createProjectManager({
      store: createMemorySystemStore(),
      runtime,
      autoReconcile: false,
      projectRecipes: [
        {
          service: {
            name: "zelavis/app",
            kind: "app",
            version: "1.0.0-test",
            api: {},
            service: {},
          },
          specifier: "zelavis/app",
          status: "available",
          source: "official",
          order: 0,
        },
        {
          service,
          specifier: installed.specifier,
          status: "installed",
          source: "community",
          order: 1,
        },
      ],
    });

    const owner = await projects.create({ id: "shop", name: "Shop" });
    const frontend = await projects.create({
      id: "shop-site",
      name: "Shop Site",
      recipeName: "@acme/theme",
      ownerProjectId: owner.id,
    });

    // The runtime driver routes on Project kind to decide whether to run a
    // frontend process. Deriving it from the package name would send
    // "@acme/theme" to the Zelavis runner instead.
    assert.equal(frontend.kind, "frontend");
    assert.equal(frontend.ownerProjectId, "shop");
    assert.equal(frontend.recipe.version, "2.1.0");
    assert.deepEqual(
      prepared.find((entry) => entry.id === "shop-site"),
      { id: "shop-site", kind: "frontend" },
    );

    // And the host can find the files it must run.
    const resolve = createLocalFrontendDirectoryResolver({ directory });
    assert.equal(
      await resolve(frontend, frontend.recipe),
      dirname(dirname(installed.specifier)),
    );

    await projects.close();
  });
});

test("a frontend that was never installed is refused, not guessed at", async () => {
  await withDirectory(async (directory) => {
    const resolve = createLocalFrontendDirectoryResolver({ directory });

    for (const specifier of ["@acme/theme", "data:text/javascript,", ""]) {
      await assert.rejects(
        resolve({}, { name: "@acme/theme", specifier }),
        /not installed as a package directory/,
        specifier,
      );
    }

    // A path outside the directory packages are installed into is not
    // something to walk the filesystem looking for.
    await assert.rejects(
      resolve({}, { name: "@acme/theme", specifier: "/etc/passwd" }),
      /does not point at an installed package/,
    );
  });
});

async function buildZip(files) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  const table = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) value = table[(value ^ byte) & 0xff] ^ (value >>> 8);
    return (value ^ 0xffffffff) >>> 0;
  };

  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const body = encoder.encode(content);
    const checksum = crc32(body);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(body.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + body.length;
  }

  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([Buffer.concat(local), centralBytes, end]));
}

test("preparing a frontend writes the record its own router reads back", async () => {
  const root = await mkdtemp(join(tmpdir(), "zelavis-frontend-prepare-"));
  const packageDirectory = join(root, "package");

  try {
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, "server.js"), "// frontend");
    await writeFile(
      join(packageDirectory, "package.json"),
      JSON.stringify(FRONTEND_MANIFEST),
    );

    const runtime = createLocalProjectRuntime({
      directory: join(root, "projects"),
      serverFrontend: {
        resolveFrontendDirectory: async () => packageDirectory,
      },
    });

    const project = {
      id: "shop-site",
      name: "Shop Site",
      kind: "frontend",
      ownerProjectId: "shop",
      runtimeKind: "native",
      recipe: {
        name: "@acme/theme",
        title: "Acme Theme",
        version: "2.1.0",
        specifier: join(packageDirectory, "dist/index.js"),
        runtimeKinds: ["native"],
      },
    };

    await runtime.prepare(project, project.recipe);
    await runtime.close();

    // `stop`, `logs`, and `destroy` take a Project id rather than a
    // descriptor, so the local runtime routes them by reading this file back to
    // find the Project's kind. A frontend that wrote only `frontend.json` could
    // be started and then never stopped.
    const record = JSON.parse(
      await readFile(join(root, "projects", "shop-site", "project.json"), "utf8"),
    );
    assert.equal(record.kind, "frontend");
    assert.equal(record.recipe.name, "@acme/theme");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
