import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// `resolveProxyTarget` is internal to the Platform composition, so the
// regression corpus exercises it directly out of the built bundle.
const source = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");
const declaration = source.match(/function resolveProxyTarget[\s\S]*?\n}\n/);
assert.ok(declaration, "resolveProxyTarget must exist in the built Platform bundle");
const resolveProxyTarget = new Function(
  `${declaration[0]}; return resolveProxyTarget;`,
)();

const RUNTIME_URL = "http://127.0.0.1:52706";

// Values a caller can put in the Gateway wildcard path. `new URL(ref, base)`
// performs reference resolution, so several of these previously resolved to a
// different origin and turned the Gateway into a confused deputy.
const HOSTILE_PATHS = [
  "https:/example.com/pwn",
  "https://example.com/pwn",
  "//example.com/pwn",
  "///example.com",
  "http:/evil.example/x",
  "\\\\example.com/pwn",
  "file:///etc/passwd",
  "data:text/html,<script>",
  "javascript:alert(1)",
  "../../etc/passwd",
  "..%2F..%2Fetc",
  "%2e%2e%2f%2e%2e",
  "a/%2e%2e/b",
  "....//",
  "%2F%2Fexample.com",
  "a/%ZZ",
  "a\r\nX-Injected: 1",
  "a\nb",
  "a\u0000b",
  "a\u007fb",
];

test("Gateway proxy targets never leave the Project runtime origin", () => {
  for (const path of HOSTILE_PATHS) {
    const target = resolveProxyTarget(RUNTIME_URL, path);
    if (target === undefined) {
      continue;
    }

    assert.equal(
      target.origin,
      RUNTIME_URL,
      `path ${JSON.stringify(path)} escaped to ${target.href}`,
    );
  }
});

test("Gateway proxy rejects traversal, control characters, and bad encoding", () => {
  for (const path of [
    "../../etc/passwd",
    "..%2F..%2Fetc",
    "a/%2e%2e/b",
    "a/%ZZ",
    "a\r\nX-Injected: 1",
    "a\u0000b",
    "\\\\example.com/pwn",
  ]) {
    assert.equal(
      resolveProxyTarget(RUNTIME_URL, path),
      undefined,
      `path ${JSON.stringify(path)} should be rejected outright`,
    );
  }
});

test("Gateway proxy preserves ordinary child paths", () => {
  assert.equal(
    resolveProxyTarget(RUNTIME_URL, "zelavis/api/v1/runtime/config")?.href,
    `${RUNTIME_URL}/zelavis/api/v1/runtime/config`,
  );
  assert.equal(resolveProxyTarget(RUNTIME_URL, "")?.href, `${RUNTIME_URL}/`);
  assert.equal(
    resolveProxyTarget(RUNTIME_URL, "deep/nested/path")?.href,
    `${RUNTIME_URL}/deep/nested/path`,
  );
  // Percent-encoded characters that are legal inside one segment survive.
  assert.equal(
    resolveProxyTarget(RUNTIME_URL, "files/my%20file.txt")?.href,
    `${RUNTIME_URL}/files/my%20file.txt`,
  );
});

test("Gateway proxy neutralizes scheme-like paths onto the runtime origin", () => {
  const target = resolveProxyTarget(RUNTIME_URL, "https://example.com/pwn");
  assert.ok(target);
  assert.equal(target.origin, RUNTIME_URL);
  // Assert the components rather than a substring: a prefix check would pass
  // for `https://example.com.evil.test`.
  assert.equal(target.protocol, "http:");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.port, "52706");
});
