import assert from "node:assert/strict";
import test from "node:test";
// The Gateway lives in its own module, so its internals are imported directly
// rather than scraped out of the bundled Platform composition.
import {
  gatewayRequestHeaders,
  gatewayResponseHeaders,
  resolveProxyTarget,
} from "../dist/platform/project-gateway.js";

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

test("Platform credentials are never relayed into a Project runtime", () => {
  const outbound = gatewayRequestHeaders(
    new Headers({
      cookie: "zelavis_session=zvs_platform_secret",
      authorization: "Bearer zvs_platform_secret",
      "content-type": "application/json",
      "x-zelavis-authority": "forged-envelope",
      "x-zelavis-project-id": "other-project",
      connection: "keep-alive",
      host: "platform.example",
      "content-length": "42",
      "x-request-id": "keep-me",
    }),
  );

  for (const header of [
    "cookie",
    "authorization",
    "x-zelavis-authority",
    "x-zelavis-project-id",
    "connection",
    "host",
    "content-length",
  ]) {
    assert.equal(
      outbound.get(header),
      null,
      `${header} must not reach the Project runtime`,
    );
  }

  // Ordinary headers still pass through.
  assert.equal(outbound.get("content-type"), "application/json");
  assert.equal(outbound.get("x-request-id"), "keep-me");
});

test("a Project cannot set cookies on the Platform origin", () => {
  const inbound = gatewayResponseHeaders(
    new Headers({
      "set-cookie": "zelavis_session=attacker_controlled; Path=/",
      "content-type": "text/html",
      connection: "close",
      "transfer-encoding": "chunked",
    }),
  );

  assert.equal(inbound.get("set-cookie"), null);
  assert.equal(inbound.get("connection"), null);
  assert.equal(inbound.get("transfer-encoding"), null);
  assert.equal(inbound.get("content-type"), "text/html");
});
