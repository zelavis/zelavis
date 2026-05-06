import assert from "node:assert/strict";
import test from "node:test";

test("S3-compatible storage is exported from zelavis and its subpath", async () => {
  const runtime = await import("zelavis");
  const s3Module = await import("zelavis/storage/s3");

  assert.equal(typeof runtime.createS3CompatibleFileStorage, "function");
  assert.equal(typeof runtime.resolveS3CacheControlPreset, "function");
  assert.equal(typeof s3Module.createS3CompatibleFileStorage, "function");
  assert.equal(
    s3Module.resolveS3CacheControlPreset("immutableAsset"),
    "public, max-age=31536000, immutable",
  );
});

test("S3-compatible storage signs requests and maps object metadata", async () => {
  const { createS3CompatibleFileStorage } = await import("zelavis/storage/s3");
  const calls = [];

  const storage = createS3CompatibleFileStorage({
    bucket: "zelavis-bucket",
    region: "eu-central-1",
    accessKeyId: "test-access-key",
    secretAccessKey: "test-secret-key",
    endpoint: "https://storage.example.com",
    forcePathStyle: true,
    prefix: "media",
    defaultHeaders: {
      cacheControlPreset: "browserShort",
      contentLanguage: "en",
    },
    fetch: async (input, init) => {
      const url = new URL(
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input.url,
      );
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? "GET",
        url: url.toString(),
        headers,
      });

      assert.ok(headers.get("authorization"));
      assert.ok(headers.get("x-amz-date"));
      assert.ok(headers.get("x-amz-content-sha256"));

      if (init?.method === "PUT") {
        assert.equal(url.pathname, "/zelavis-bucket/media/hero.jpg");
        assert.equal(headers.get("cache-control"), "public, max-age=3600");
        assert.equal(headers.get("content-disposition"), 'inline; filename="hero.jpg"');
        assert.equal(headers.get("content-language"), "en");
        assert.equal(headers.get("x-amz-meta-label"), "Hero image");
        return new Response(null, { status: 200 });
      }

      if (init?.method === "GET" && url.searchParams.get("list-type") === "2") {
        return new Response(
          [
            '<?xml version="1.0" encoding="UTF-8"?>',
            "<ListBucketResult>",
            "<IsTruncated>false</IsTruncated>",
            "<Contents>",
            "<Key>media/hero.jpg</Key>",
            "<LastModified>2026-05-06T12:00:00.000Z</LastModified>",
            "<Size>123</Size>",
            "</Contents>",
            "</ListBucketResult>",
          ].join(""),
          {
            status: 200,
            headers: {
              "content-type": "application/xml",
            },
          },
        );
      }

      if (init?.method === "GET") {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": "3",
            "cache-control": "public, max-age=3600",
            "content-disposition": 'inline; filename="hero.jpg"',
            "x-amz-meta-label": "Hero image",
            "last-modified": "Tue, 06 May 2026 12:00:00 GMT",
          },
        });
      }

      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
          },
        });
      }

      if (init?.method === "DELETE") {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
    },
  });

  const written = await storage.put({
    path: "hero.jpg",
    body: new Uint8Array([1, 2, 3]),
    contentType: "image/jpeg",
    cacheControl: "public, max-age=3600",
    contentDisposition: 'inline; filename="hero.jpg"',
    metadata: {
      label: "Hero image",
    },
  });
  const listed = await storage.list();
  const read = await storage.get("hero.jpg");
  const deleted = await storage.delete("hero.jpg");

  assert.equal(written.path, "hero.jpg");
  assert.equal(written.cacheControl, "public, max-age=3600");
  assert.equal(written.contentDisposition, 'inline; filename="hero.jpg"');
  assert.deepEqual(listed, [
    {
      path: "hero.jpg",
      size: 123,
      updatedAt: new Date("2026-05-06T12:00:00.000Z"),
    },
  ]);
  assert.equal(read?.contentType, "image/jpeg");
  assert.equal(read?.cacheControl, "public, max-age=3600");
  assert.equal(read?.contentDisposition, 'inline; filename="hero.jpg"');
  assert.deepEqual(read?.metadata, {
    label: "Hero image",
  });
  assert.deepEqual(written.metadata, {
    label: "Hero image",
    contentLanguage: "en",
  });
  assert.equal(deleted, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["PUT", "GET", "GET", "HEAD", "DELETE"],
  );
});
