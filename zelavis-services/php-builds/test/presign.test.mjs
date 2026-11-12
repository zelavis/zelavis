import assert from "node:assert/strict";
import test from "node:test";

import { presignUrl } from "../dist/presign.js";

test("it reproduces AWS's published presigned-URL example", () => {
  // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
  const url = presignUrl({
    method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    expiresSeconds: 86_400, now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");
  assert.equal(new URL(url).searchParams.get("X-Amz-Credential"), "AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request");
});

test("an R2 upload address names the bucket in the path and signs only the host", () => {
  const url = new URL(presignUrl({
    method: "PUT", host: "abc123.r2.cloudflarestorage.com", path: "/zelavis-mirror/php/8.4.23/php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz",
    region: "auto", accessKeyId: "key", secretAccessKey: "secret", expiresSeconds: 3600, now: new Date("2026-10-12T10:00:00Z"),
  }));
  assert.equal(url.pathname, "/zelavis-mirror/php/8.4.23/php-8.4.23-d2fd8460-cli-linux-aarch64.tar.gz");
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "3600");
  assert.match(url.searchParams.get("X-Amz-Signature"), /^[0-9a-f]{64}$/);
  // What the upload operation's pattern accepts.
  assert.match(url.href, /^https:\/\/[a-z0-9-]+\.r2\.cloudflarestorage\.com\/[A-Za-z0-9._~\/%-]+\?[A-Za-z0-9._~%=&+\/:-]+$/);
});

test("a lifetime outside what S3 allows is refused", () => {
  const base = { method: "PUT", host: "h", path: "/b/k", region: "auto", accessKeyId: "a", secretAccessKey: "s", now: new Date() };
  assert.throws(() => presignUrl({ ...base, expiresSeconds: 0 }), RangeError);
  assert.throws(() => presignUrl({ ...base, expiresSeconds: 604_801 }), RangeError);
});
