import assert from "node:assert/strict";
import test from "node:test";
import {
  injectFrontendBasePath,
  rewriteBundleAssetBase,
} from "../dist/service-app.js";
import { readFrontendManifest } from "../dist/core/service/frontend.js";

const encode = (text) => new TextEncoder().encode(text);
const decode = (bytes) => new TextDecoder().decode(bytes);

const HTML = "text/html; charset=utf-8";

function manifest(frontend) {
  return readFrontendManifest({
    name: "@acme/face",
    type: "module",
    exports: "./index.js",
    zelavis: { kind: "frontend", frontend: { runtime: "static", bundle: "build", ...frontend } },
  });
}

test("the served page is told where it is mounted", () => {
  const out = decode(
    injectFrontendBasePath(
      encode("<html><head><title>x</title></head><body></body></html>"),
      HTML,
      "__ZELAVIS_BASE_PATH__",
      "/admin",
    ),
  );

  // First inside <head>, so the value exists before anything else on the page
  // runs — including the script that reads it.
  assert.match(out, /<head><script>window\["__ZELAVIS_BASE_PATH__"\]="\/admin";<\/script><title>/u);
});

test("a root mount is declared as the root, not an empty string", () => {
  const out = decode(
    injectFrontendBasePath(encode("<head></head>"), HTML, "B", "/"),
  );
  assert.match(out, /window\["B"\]="\/"/u);
});

test("only HTML is touched", () => {
  for (const contentType of ["application/javascript", "text/css", "image/svg+xml"]) {
    const body = encode("body{}");
    assert.equal(
      decode(injectFrontendBasePath(body, contentType, "B", "/admin")),
      "body{}",
    );
  }
});

test("the injected value cannot break out of the script element", () => {
  const out = decode(
    injectFrontendBasePath(encode("<head></head>"), HTML, "B", "/</script><script>alert(1)"),
  );
  // The mount is JSON-encoded and normalized, so a crafted root path cannot
  // close the element and append statements.
  assert.ok(!out.includes("<script>alert(1)"));
});

test("a manifest may declare which global carries the mount path", () => {
  assert.equal(
    manifest({ basePathGlobal: "__ZELAVIS_BASE_PATH__" }).basePathGlobal,
    "__ZELAVIS_BASE_PATH__",
  );
});

test("a global name that is not an identifier is refused", () => {
  // It is written into a script tag, so anything else would let a manifest
  // close the assignment and append statements of its own.
  for (const name of ['x"];alert(1);//', "with space", "1bad", "", "a-b"]) {
    assert.throws(
      () => manifest({ basePathGlobal: name }),
      /plain JavaScript identifier/u,
      `expected ${JSON.stringify(name)} to be refused`,
    );
  }
});

test("unquoted CSS references are rewritten for the mount", () => {
  // CSS writes `url(/assets/font.woff2)` with no quotes. A quote-only anchor
  // left every font and background image pointing at the server root, which
  // 404s on any installation not mounted there.
  const css = "@font-face{src:url(/assets/inter.woff2) format('woff2')}";
  assert.equal(
    decode(rewriteBundleAssetBase(encode(css), "text/css", "/assets/", "/admin")),
    "@font-face{src:url(/admin/assets/inter.woff2) format('woff2')}",
  );
});

test("a path that merely contains the base is still left alone", () => {
  const js = '// see https://cdn.example.com/assets/x.js\nconst a = "/assets/real.js";';
  const out = decode(
    rewriteBundleAssetBase(encode(js), "application/javascript", "/assets/", "/admin"),
  );
  assert.ok(out.includes('"/admin/assets/real.js"'));
  assert.ok(out.includes("https://cdn.example.com/assets/x.js"));
});
