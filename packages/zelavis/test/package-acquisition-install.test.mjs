import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalRuntimeServicePackageInstaller } from "../dist/adapters/_local-runtime.js";

const NPM = "https://registry.npmjs.org";

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "zelavis-acquire-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("an installer with no configured sources cannot acquire anything", async () => {
  await withDirectory(async (directory) => {
    const installer = createLocalRuntimeServicePackageInstaller({ directory });

    // The capability is present, but the policy is empty. That distinction
    // matters: the operator gets a refusal that says why, not a 404.
    await assert.rejects(
      installer.acquire({ reference: "npm:@zelavis/anything@1.0.0" }),
      /does not allow acquiring packages from remote sources/,
    );
  });
});

test("a configured installer refuses a source outside its policy", async () => {
  await withDirectory(async (directory) => {
    const installer = createLocalRuntimeServicePackageInstaller({
      directory,
      sources: { npm: { registries: [NPM], scopes: ["@zelavis"] } },
    });

    await assert.rejects(
      installer.acquire({ reference: "npm:@someone-else/thing@1.0.0" }),
      /outside the scopes/,
    );
    await assert.rejects(
      installer.acquire({ reference: "https://example.test/pkg.tgz" }),
      /does not allow installing packages from arbitrary URLs/,
    );
  });
});

test("an uploaded package still installs, and installs once", async () => {
  await withDirectory(async (directory) => {
    const installer = createLocalRuntimeServicePackageInstaller({ directory });
    const zip = await buildZip({
      "package.json": JSON.stringify({
        name: "@example/uploaded",
        version: "1.0.0",
        type: "module",
        exports: { ".": { import: "./index.js" } },
        zelavis: { kind: "plugin" },
      }),
      "index.js": "export default { name: '@example/uploaded' }",
    });

    const first = await installer.install({ fileName: "p.zip", body: zip });
    const second = await installer.install({ fileName: "p.zip", body: zip });

    // Content-addressed: the same bytes land in the same place.
    assert.equal(first.specifier, second.specifier);
    assert.match(first.specifier, /index\.js$/);
  });
});

// Minimal stored (uncompressed) ZIP writer, matching the reader's expectations.
async function buildZip(files) {
  const encoder = new TextEncoder();
  const { createHash } = await import("node:crypto");
  void createHash;
  const local = [];
  const central = [];
  let offset = 0;

  const crcTable = Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  });
  const crc32 = (bytes) => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
  };

  for (const [path, content] of Object.entries(files)) {
    const name = encoder.encode(path);
    const body = encoder.encode(content);
    const checksum = crc32(body);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 8);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(body.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 10);
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

  return new Uint8Array(
    Buffer.concat([Buffer.concat(local), centralBytes, end]),
  );
}
