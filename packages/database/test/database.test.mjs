import assert from "node:assert/strict";
import test from "node:test";
import { createDatabase } from "../dist/index.js";

test("database documents support tenant-aware CRUD operations", async () => {
  const database = await createDatabase();

  await database.documents.createCollection({ name: "products" });
  await database.documents.createCollection({
    tenantId: "enterprise",
    name: "products",
  });

  const product = await database.documents.insert({
    collection: "products",
    data: {
      name: "T-shirt",
      status: "published",
      price: 25,
    },
  });

  await database.documents.insert({
    tenantId: "enterprise",
    collection: "products",
    data: {
      name: "Private catalog",
      status: "published",
      price: 50,
    },
  });

  const found = await database.documents.findById({
    collection: "products",
    id: product.id,
  });
  assert.equal(found.data.name, "T-shirt");

  const defaultTenantProducts = await database.documents.findMany({
    collection: "products",
    where: [{ path: "status", value: "published" }],
  });
  assert.equal(defaultTenantProducts.length, 1);
  assert.equal(defaultTenantProducts[0].tenantId, "default");

  const updated = await database.documents.update({
    collection: "products",
    id: product.id,
    data: { status: "archived" },
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.data.name, "T-shirt");
  assert.equal(updated.data.status, "archived");

  assert.equal(
    await database.documents.delete({
      collection: "products",
      id: product.id,
    }),
    true,
  );
});

test("database keeps SQL as an optional capability", async () => {
  const database = await createDatabase();

  assert.equal(database.capabilities.documents, true);
  assert.equal(database.capabilities.events, true);
  assert.equal(database.capabilities.sql, false);
  assert.equal(database.sql, undefined);
});

test("database exposes an event stream behind document operations", async () => {
  const database = await createDatabase({ defaultNodeId: "test-node" });

  await database.documents.createCollection({ name: "products" });
  const created = await database.documents.insert({
    collection: "products",
    id: "shirt_1",
    data: {
      name: "T-shirt",
      status: "draft",
    },
  });

  await database.documents.update({
    collection: "products",
    id: created.id,
    data: { status: "published" },
  });

  const events = await database.events.read({ collection: "products" });

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "collection.created");
  assert.equal(events[0].nodeId, "test-node");
  assert.equal(events[1].type, "document.upserted");
  assert.equal(events[1].documentId, "shirt_1");
  assert.equal(events[1].revision, 1);
  assert.equal(events[2].type, "document.upserted");
  assert.equal(events[2].revision, 2);
  assert.equal(created.schemaVersion, 1);
});

test("database validates documents against registered collection schemas", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "products",
        version: 1,
        activate: true,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["name", "price", "status"],
          properties: {
            name: { type: "string", minLength: 1 },
            price: { type: "number", minimum: 0 },
            status: {
              type: "string",
              enum: ["draft", "published"],
            },
          },
        },
      },
    ],
  });

  await database.documents.createCollection({ name: "products" });

  assert.throws(
    () =>
      database.documents.insert({
        collection: "products",
        data: {
          name: "Broken product",
          price: -10,
          status: "draft",
          extra: true,
        },
      }),
    (error) => {
      assert.equal(error.name, "DatabaseSchemaValidationError");
      assert.match(error.message, /Schema validation failed/);
      return true;
    },
  );

  const valid = await database.documents.insert({
    collection: "products",
    data: {
      name: "Working product",
      price: 25,
      status: "published",
    },
  });

  assert.equal(valid.schemaVersion, 1);
});

test("database schema validation reports both structural and custom issues", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "products",
        version: 1,
        activate: true,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["name", "price"],
          properties: {
            name: { type: "string", minLength: 3 },
            price: { type: "number", minimum: 0 },
          },
        },
        validate(input) {
          if (input.name === "bad") {
            return {
              valid: false,
              issues: [
                {
                  path: "$.name",
                  message: "must not be reserved",
                },
              ],
            };
          }
        },
      },
    ],
  });

  const result = database.schemas.validate({
    collection: "products",
    data: {
      name: "bad",
      price: -5,
      extra: true,
    },
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.validation.valid, false);
  assert.deepEqual(result.validation.issues, [
    {
      path: "$.price",
      message: "must be >= 0",
    },
    {
      path: "$.extra",
      message: "is not allowed",
    },
    {
      path: "$.name",
      message: "must not be reserved",
    },
  ]);
});

test("database can activate newer schema versions for later writes", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "products",
        version: 1,
        activate: true,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: { type: "string", minLength: 1 },
          },
        },
      },
    ],
  });

  await database.documents.createCollection({ name: "products" });

  const created = await database.documents.insert({
    collection: "products",
    id: "product_1",
    data: {
      name: "First version",
    },
  });

  assert.equal(created.schemaVersion, 1);

  await database.schemas.register({
    collection: "products",
    version: 2,
    document: {
      type: "object",
      additionalProperties: false,
      required: ["name", "status"],
      properties: {
        name: { type: "string", minLength: 1 },
        status: {
          type: "string",
          enum: ["draft", "published"],
        },
      },
    },
  });
  await database.schemas.activate("products", 2);

  await assert.rejects(() =>
    database.documents.update({
      collection: "products",
      id: created.id,
      data: {
        name: "Missing status",
      },
      mode: "replace",
    }),
  );

  const updated = await database.documents.update({
    collection: "products",
    id: created.id,
    data: {
      name: "Second version",
      status: "draft",
    },
    mode: "replace",
  });

  assert.equal(updated.schemaVersion, 2);
  assert.deepEqual(database.schemas.listCollections(), [
    {
      collection: "products",
      activeVersion: 2,
      versions: [1, 2],
    },
  ]);
});

test("database schemas can validate Zelavis file references natively", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "assets",
        version: 1,
        activate: true,
        document: {
          type: "object",
          additionalProperties: false,
          required: ["title", "file"],
          properties: {
            title: { type: "string", minLength: 1 },
            file: {
              type: "file",
              mimeTypes: ["image/png"],
              maxSize: 1024,
            },
          },
        },
      },
    ],
  });

  await database.documents.createCollection({ name: "assets" });

  const created = await database.documents.insert({
    collection: "assets",
    data: {
      title: "Logo",
      file: {
        kind: "file",
        path: "branding/logo.png",
        href: "/zelavis/api/v1/storage/files/branding/logo.png",
        metadataHref:
          "/zelavis/api/v1/storage/files/branding/logo.png?format=metadata",
        contentType: "image/png",
        size: 512,
        checksum: "abc123",
      },
    },
  });

  assert.equal(created.schemaVersion, 1);

  assert.throws(
    () =>
      database.documents.insert({
        collection: "assets",
        data: {
          title: "Too large",
          file: {
            kind: "file",
            path: "branding/manual.pdf",
            href: "/zelavis/api/v1/storage/files/branding/manual.pdf",
            metadataHref:
              "/zelavis/api/v1/storage/files/branding/manual.pdf?format=metadata",
            contentType: "application/pdf",
            size: 4096,
          },
        },
      }),
    (error) => {
      assert.equal(error.name, "DatabaseSchemaValidationError");
      assert.match(error.message, /must use one of image\/png/);
      return true;
    },
  );
});

test("database deduplicates repeated event appends by idempotency key", async () => {
  const database = await createDatabase();

  const first = await database.events.append({
    collection: "products",
    type: "collection.created",
    expectedRevision: 0,
    idempotencyKey: "create-products",
    payload: {
      metadata: {
        source: "test",
      },
    },
  });

  const repeated = await database.events.append({
    collection: "products",
    type: "collection.created",
    expectedRevision: 0,
    idempotencyKey: "create-products",
    payload: {
      metadata: {
        source: "test",
      },
    },
  });

  const events = await database.events.read({ collection: "products" });

  assert.equal(repeated.eventId, first.eventId);
  assert.equal(repeated.idempotencyKey, "create-products");
  assert.equal(events.length, 1);
});

test("database rejects conflicting event appends for the same idempotency key", async () => {
  const database = await createDatabase();

  await database.events.append({
    collection: "products",
    type: "collection.created",
    expectedRevision: 0,
    idempotencyKey: "create-products",
    payload: {
      metadata: {
        source: "first",
      },
    },
  });

  await assert.rejects(
    () =>
      database.events.append({
        collection: "products",
        type: "collection.created",
        expectedRevision: 0,
        idempotencyKey: "create-products",
        payload: {
          metadata: {
            source: "second",
          },
        },
      }),
    (error) => {
      assert.equal(error.name, "DatabaseEventIdempotencyConflictError");
      assert.match(error.message, /Idempotency key/);
      return true;
    },
  );
});

test("database exposes the built-in document projection and allows registry additions", async () => {
  const database = await createDatabase();

  const initial = await database.projections.list();

  assert.deepEqual(initial, [
    {
      name: "documents",
      builtin: true,
      description:
        "Built-in projection that materializes collection and document reads from the event log.",
      sourceCollections: undefined,
      sourceEventTypes: [
        "collection.created",
        "document.upserted",
        "document.deleted",
      ],
    },
  ]);

  await database.projections.register({
    name: "timeseries.metrics",
    description: "Future metrics projection contract.",
    source: {
      collections: ["metrics"],
      eventTypes: ["document.upserted"],
    },
  });

  const projections = await database.projections.list();

  assert.deepEqual(
    projections.map((projection) => ({
      name: projection.name,
      builtin: projection.builtin,
    })),
    [
      { name: "documents", builtin: true },
      { name: "timeseries.metrics", builtin: false },
    ],
  );

  const rebuilt = await database.projections.rebuild({
    names: ["timeseries.metrics"],
  });

  assert.deepEqual(rebuilt, {
    rebuilt: ["timeseries.metrics"],
  });
});

test("database projection registry rejects duplicates and unknown rebuild targets", async () => {
  const database = await createDatabase();

  await assert.rejects(
    () =>
      database.projections.register({
        name: "documents",
      }),
    /already registered/,
  );

  await assert.rejects(
    () =>
      database.projections.rebuild({
        names: ["missing"],
      }),
    /unknown projections/,
  );
});

test("database exposes a time-series definition registry linked to projections", async () => {
  const database = await createDatabase();

  await database.projections.register({
    name: "timeseries.metrics",
    description: "Metrics projection.",
    source: {
      collections: ["metrics"],
      eventTypes: ["document.upserted"],
    },
  });

  await database.timeseries.define({
    name: "metrics",
    description: "Application metrics.",
    projection: "timeseries.metrics",
  });

  const series = await database.timeseries.list();

  assert.deepEqual(series, [
    {
      name: "metrics",
      description: "Application metrics.",
      projection: "timeseries.metrics",
    },
  ]);
});

test("database time-series registry validates projection references and mapper requirements", async () => {
  const database = await createDatabase();

  await assert.rejects(
    () =>
      database.timeseries.define({
        name: "missing-projection-series",
        projection: "timeseries.missing",
      }),
    /Unknown projection/,
  );

  await database.timeseries.define({
    name: "metrics",
  });

  assert.throws(() => database.timeseries.get("unknown"), /is not defined/);

  await assert.rejects(
    () => database.timeseries.get("metrics").range(),
    /does not define an event mapper yet/,
  );

  await assert.rejects(
    () =>
      database.timeseries.get("metrics").aggregate({
        op: "avg",
      }),
    /does not define an event mapper yet/,
  );
});

test("database executes mapped time-series range and aggregate queries from events", async () => {
  const database = await createDatabase();

  await database.documents.createCollection({ name: "metrics" });

  await database.projections.register({
    name: "timeseries.metrics",
    source: {
      collections: ["metrics"],
      eventTypes: ["document.upserted"],
    },
  });

  await database.timeseries.define({
    name: "metrics",
    projection: "timeseries.metrics",
    source: {
      collections: ["metrics"],
      eventTypes: ["document.upserted"],
    },
    map(event) {
      if (event.type !== "document.upserted") {
        return null;
      }

      return {
        timestamp: event.payload.data.timestamp,
        value: event.payload.data.value,
        tags: {
          metric: String(event.payload.data.metric),
        },
        fields: {
          region: event.payload.data.region,
        },
      };
    },
  });

  await database.documents.insert({
    collection: "metrics",
    id: "m1",
    data: {
      timestamp: "2026-01-01T00:00:00.000Z",
      value: 10,
      metric: "cpu",
      region: "eu",
    },
  });
  await database.documents.insert({
    collection: "metrics",
    id: "m2",
    data: {
      timestamp: "2026-01-01T00:01:00.000Z",
      value: 20,
      metric: "cpu",
      region: "eu",
    },
  });
  await database.documents.insert({
    collection: "metrics",
    id: "m3",
    data: {
      timestamp: "2026-01-01T00:02:00.000Z",
      value: 30,
      metric: "cpu",
      region: "us",
    },
  });

  const range = await database.timeseries.get("metrics").range({
    start: "2026-01-01T00:00:30.000Z",
    end: "2026-01-01T00:02:00.000Z",
    order: "desc",
  });

  assert.deepEqual(
    range.map((point) => point.value),
    [30, 20],
  );
  assert.deepEqual(range[0].tags, { metric: "cpu" });

  const avg = await database.timeseries.get("metrics").aggregate({
    op: "avg",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-01T00:02:00.000Z",
  });
  const sum = await database.timeseries.get("metrics").aggregate({
    op: "sum",
  });
  const count = await database.timeseries.get("metrics").aggregate({
    op: "count",
    start: "2026-01-01T00:01:00.000Z",
  });

  assert.equal(avg, 20);
  assert.equal(sum, 60);
  assert.equal(count, 2);
});
