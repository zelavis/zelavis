import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertPackageSourceAllowed,
  assertTarballOrigin,
  parsePackageSourceRef,
} from "../dist/platform/package-sources.js";
import {
  acquirePackage,
  readTarGzEntries,
  stripPackagePrefix,
  verifyIntegrity,
} from "../dist/adapters/_package-acquisition.js";

const NPM = "https://registry.npmjs.org";
const POLICY = { npm: { registries: [NPM], scopes: ["@zelavis"] } };

test("a reference must name one package, not a range", () => {
  assert.equal(parsePackageSourceRef("npm:@zelavis/x@1.2.3").version, "1.2.3");
  assert.equal(parsePackageSourceRef("npm:@zelavis/x").version, "latest");

  // A partial version is a range wearing a version's clothes.
  for (const range of ["^1.0.0", "~1.0.0", ">=1.0.0", "1.x", "1.2.x", "1", "1.2", "*", "1.0.0 - 2.0.0"]) {
    assert.throws(
      () => parsePackageSourceRef(`npm:@zelavis/x@${range}`),
      /not an exact version or a dist-tag/,
      range,
    );
  }

  // Exact versions and dist-tags both name one package.
  for (const version of ["1.2.3", "1.2.3-rc.1", "1.2.3+build.5", "latest", "next"]) {
    assert.equal(
      parsePackageSourceRef(`npm:@zelavis/x@${version}`).version,
      version,
      version,
    );
  }
});

test("a package name cannot be used to reach another path", () => {
  for (const name of [
    "../etc/passwd",
    "@zelavis/../../evil",
    "@zelavis/a/b",
    "@/x",
    "@zelavis",
  ]) {
    assert.throws(() => parsePackageSourceRef(`npm:${name}`), name);
  }
});

test("nothing is acquirable without a policy", () => {
  const ref = parsePackageSourceRef("npm:@zelavis/x@1.0.0");
  assert.throws(
    () => assertPackageSourceAllowed(ref, undefined),
    /does not allow acquiring packages/,
  );
  assert.throws(
    () => assertPackageSourceAllowed(ref, {}),
    /does not allow installing packages from npm/,
  );
});

test("a registry that merely looks like an allowed one is refused", () => {
  for (const registry of [
    "https://registry.npmjs.org.evil.test",
    "https://evil.test/registry.npmjs.org",
    "https://registry.npmjs.org.co",
  ]) {
    const ref = parsePackageSourceRef("npm:@zelavis/x@1.0.0", {
      defaultRegistry: registry,
    });
    assert.throws(
      () => assertPackageSourceAllowed(ref, POLICY),
      /not an allowed package source/,
      registry,
    );
  }
});

test("a scope that merely looks like an allowed one is refused", () => {
  for (const name of ["@zelavis-evil/x", "@zelavisx/x", "@evil/x", "plain"]) {
    const ref = parsePackageSourceRef(`npm:${name}@1.0.0`);
    assert.throws(
      () => assertPackageSourceAllowed(ref, POLICY),
      /outside the scopes/,
      name,
    );
  }
});

test("a registry cannot redirect the download to another host", () => {
  assert.throws(
    () => assertTarballOrigin("https://evil.test/x.tgz", NPM),
    /not an allowed package source/,
  );
  assert.throws(
    () => assertTarballOrigin("https://registry.npmjs.org.evil.test/x.tgz", NPM),
    /not an allowed package source/,
  );
  assert.equal(
    assertTarballOrigin(`${NPM}/@zelavis/x/-/x-1.0.0.tgz`, NPM).origin,
    NPM,
  );
});

test("integrity is checked, and sha1 is not a commitment", () => {
  const body = new TextEncoder().encode("payload");
  const sha512 = `sha512-${createHash("sha512").update(body).digest("base64")}`;

  verifyIntegrity(body, sha512);
  assert.throws(
    () => verifyIntegrity(new TextEncoder().encode("tampered"), sha512),
    /integrity check failed/,
  );
  assert.throws(
    () => verifyIntegrity(body, `sha1-${createHash("sha1").update(body).digest("base64")}`),
    /sha1 is not accepted/,
  );
  assert.throws(() => verifyIntegrity(body, ""), /did not include an integrity digest/);
});

// --- acquisition against a fake registry ------------------------------------

function tarEntry(path, body, typeFlag = "0") {
  const header = new Uint8Array(512);
  const write = (text, offset, length) => {
    const bytes = new TextEncoder().encode(text);
    header.set(bytes.subarray(0, length), offset);
  };
  write(path, 0, 100);
  write("000644 ", 100, 8);
  write(`${body.length.toString(8).padStart(11, "0")} `, 124, 12);
  header[156] = typeFlag.charCodeAt(0);
  write("ustar\0" + "00", 257, 8);
  // Header checksum is computed with the checksum field read as spaces.
  header.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);

  const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
  padded.set(body);
  return [header, padded];
}

function makeTarball(files, typeFlag = "0") {
  const parts = [];
  for (const [path, content] of Object.entries(files)) {
    parts.push(...tarEntry(path, new TextEncoder().encode(content), typeFlag));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((size, part) => size + part.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return new Uint8Array(gzipSync(tar));
}

function fakeRegistry(tarball, { version = "1.0.0", tarballUrl, integrity } = {}) {
  const digest = integrity ??
    `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

  return async (url) => {
    const target = String(url);
    if (target.endsWith(".tgz")) {
      return new Response(tarball, { status: 200 });
    }
    return new Response(
      JSON.stringify({
        version,
        dist: {
          tarball: tarballUrl ?? `${NPM}/@zelavis/x/-/x-${version}.tgz`,
          integrity: digest,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

test("a package is acquired, verified, and stripped of its wrapper directory", async () => {
  const tarball = makeTarball({
    "package/package.json": '{"name":"@zelavis/x"}',
    "package/dist/index.js": "export default {}",
  });

  const result = await acquirePackage("npm:@zelavis/x@1.0.0", {
    policy: POLICY,
    fetch: fakeRegistry(tarball),
  });

  assert.deepEqual(
    result.entries.map((entry) => entry.path).sort(),
    ["dist/index.js", "package.json"],
  );
  assert.equal(result.resolved, "npm:@zelavis/x@1.0.0");
});

test("a dist-tag records the version it resolved to", async () => {
  const tarball = makeTarball({ "package/package.json": "{}" });

  const result = await acquirePackage("npm:@zelavis/x@latest", {
    policy: POLICY,
    fetch: fakeRegistry(tarball, { version: "2.5.1" }),
  });

  // The tag moves; what was installed must stay legible after it does.
  assert.equal(result.resolved, "npm:@zelavis/x@2.5.1");
});

test("a tampered tarball is refused even from an allowed registry", async () => {
  const tarball = makeTarball({ "package/package.json": "{}" });
  const other = makeTarball({ "package/package.json": '{"evil":true}' });

  await assert.rejects(
    acquirePackage("npm:@zelavis/x@1.0.0", {
      policy: POLICY,
      // Metadata describes one archive; the download serves another.
      fetch: fakeRegistry(other, {
        integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
      }),
    }),
    /integrity check failed/,
  );
});

test("a registry cannot point the download at another host", async () => {
  const tarball = makeTarball({ "package/package.json": "{}" });

  await assert.rejects(
    acquirePackage("npm:@zelavis/x@1.0.0", {
      policy: POLICY,
      fetch: fakeRegistry(tarball, { tarballUrl: "https://evil.test/x.tgz" }),
    }),
    /not an allowed package source/,
  );
});

test("metadata without an integrity digest is refused", async () => {
  await assert.rejects(
    acquirePackage("npm:@zelavis/x@1.0.0", {
      policy: POLICY,
      fetch: async () =>
        new Response(JSON.stringify({ dist: { tarball: `${NPM}/x.tgz` } }), {
          status: 200,
        }),
    }),
    /no integrity digest/,
  );
});

test("a tarball cannot smuggle a symlink or escape its root", () => {
  assert.throws(
    () => readTarGzEntries(makeTarball({ "package/evil": "../../etc/passwd" }, "2")),
    /not a regular file/,
  );
  assert.throws(
    () => stripPackagePrefix([{ path: "../evil", body: new Uint8Array() }]),
    /outside the package root/,
  );
  assert.throws(
    () => stripPackagePrefix([{ path: "other/evil", body: new Uint8Array() }]),
    /outside the package root/,
  );
});
