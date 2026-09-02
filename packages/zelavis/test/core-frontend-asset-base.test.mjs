import assert from "node:assert/strict";
import test from "node:test";

import { rewriteBundleAssetBase } from "../dist/service-app.js";
import {
  readFrontendManifest,
  toServiceAppDefinition,
} from "../dist/core/service/frontend.js";

const encode = (value) => new TextEncoder().encode(value);
const decode = (value) => new TextDecoder().decode(value);

const rewrite = (source, mount, contentType = "text/html; charset=utf-8") =>
  decode(rewriteBundleAssetBase(encode(source), contentType, "/assets/", mount));

test("a bundle built for one base serves from another", () => {
  const html = `<link rel="stylesheet" href="/assets/root-abc.css"/><script src="/assets/entry.js"></script>`;

  // The installation's root path is a runtime setting, so the same build has
  // to work wherever it is mounted rather than being rebuilt per install.
  assert.equal(
    rewrite(html, "/zelavis"),
    `<link rel="stylesheet" href="/zelavis/assets/root-abc.css"/><script src="/zelavis/assets/entry.js"></script>`,
  );

  // Mounted at the root there is nothing to add, and adding an empty prefix
  // would still rewrite the bytes for no reason.
  assert.equal(rewrite(html, "/"), html);
});

test("only the declared asset base moves", () => {
  const source = `fetch("/zelavis/api/v1/runtime/config"); import "/assets/chunk.js";`;

  // A link to an API route is not the bundle's to move. Rewriting every
  // absolute path would break exactly the calls the frontend depends on.
  assert.equal(
    rewrite(source, "/zelavis", "application/javascript"),
    `fetch("/zelavis/api/v1/runtime/config"); import "/zelavis/assets/chunk.js";`,
  );
});

test("a reference is only a reference at the start of a quoted string", () => {
  // A path that merely contains the base — a sourcemap comment, a string built
  // at runtime, prose — is left alone.
  const source = `// see /assets/readme\nconst p = base + "/assets/x.js";\nconst q = "/assets/y.js";`;
  const result = rewrite(source, "/zelavis", "application/javascript");

  assert.match(result, /\/\/ see \/assets\/readme/);
  assert.match(result, /const q = "\/zelavis\/assets\/y\.js"/);
});

test("binary assets are never rewritten", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  assert.deepEqual(
    rewriteBundleAssetBase(png, "image/png", "/assets/", "/zelavis"),
    png,
  );
});

test("a manifest declares the base, and it reaches the app definition", () => {
  const manifest = {
    name: "@acme/theme",
    zelavis: {
      kind: "frontend",
      frontend: {
        runtime: "static",
        bundle: "build/client",
        mode: "spa",
        assetBase: "/assets/",
      },
    },
  };

  const frontend = readFrontendManifest(manifest);
  assert.equal(frontend.assetBase, "/assets/");

  // This is what a JSON manifest could not express before: serving one build
  // from a configurable mount needed a render function, which is why the
  // dashboard had to be composed rather than installed.
  assert.equal(toServiceAppDefinition(frontend).assetBase, "/assets/");
});

test("an asset base that would rewrite too much is refused", () => {
  const withBase = (assetBase) => ({
    name: "@acme/theme",
    zelavis: {
      kind: "frontend",
      frontend: { runtime: "static", bundle: "build/client", assetBase },
    },
  });

  // "/" matches every absolute reference, including API routes.
  assert.throws(() => readFrontendManifest(withBase("/")), /more specific than/);

  // A prefix that is not a directory would rewrite partial matches.
  for (const invalid of ["assets/", "/assets", "assets"]) {
    assert.throws(
      () => readFrontendManifest(withBase(invalid)),
      /absolute directory path/,
      invalid,
    );
  }
});
