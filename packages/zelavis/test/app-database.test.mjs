import assert from "node:assert/strict";
import test from "node:test";
import {
  createDatabase,
  parseWriteTargetTable,
} from "../dist/app/db/index.js";

test("database documents support tenant-aware CRUD operations", async () => {
  const database = await createDatabase();
  const standard = database.forTenant("default");
  const enterprise = database.forTenant("enterprise");

  await standard.documents.createCollection({ name: "products" });
  await enterprise.documents.createCollection({ name: "products" });

  const product = await standard.documents.insert({
    collection: "products",
    data: {
      name: "T-shirt",
      status: "published",
      price: 25,
    },
  });

  await enterprise.documents.insert({
    collection: "products",
    data: {
      name: "Private catalog",
      status: "published",
      price: 50,
    },
  });

  const found = await standard.documents.findById({
    collection: "products",
    id: product.id,
  });
  assert.equal(found.data.name, "T-shirt");

  const defaultTenantProducts = await standard.documents.findMany({
    collection: "products",
    where: [{ path: "status", value: "published" }],
  });
  assert.equal(defaultTenantProducts.length, 1);
  assert.equal(defaultTenantProducts[0].tenantId, "default");

  const updated = await standard.documents.update({
    collection: "products",
    id: product.id,
    data: { status: "archived" },
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.data.name, "T-shirt");
  assert.equal(updated.data.status, "archived");

  assert.equal(
    await standard.documents.delete({
      collection: "products",
      id: product.id,
    }),
    true,
  );
});

test("database keeps physical drivers and SQL out of the logical API", async () => {
  const database = await createDatabase();

  assert.equal(database.capabilities.documents, true);
  assert.equal(database.capabilities.events, true);
  assert.equal(Object.hasOwn(database.capabilities, "sql"), false);
  assert.equal(database.sql, undefined);
  assert.equal(database.driver, undefined);
  assert.throws(() => database.forTenant(" "), /Tenant ID/);
});

test("database exposes an event stream behind document operations", async () => {
  const database = await createDatabase({ nodeId: "test-node" });

  await database.forTenant("default").documents.createCollection({ name: "products" });
  const created = await database.forTenant("default").documents.insert({
    collection: "products",
    id: "shirt_1",
    data: {
      name: "T-shirt",
      status: "draft",
    },
  });

  await database.forTenant("default").documents.update({
    collection: "products",
    id: created.id,
    data: { status: "published" },
  });

  const events = await database.forTenant("default").events.read({ collection: "products" });

  assert.equal(events.length, 3);
  assert.equal(events[0].type, "collection.created");
  assert.equal(events[0].nodeId, "test-node");
  assert.equal(events[1].type, "document.upserted");
  assert.equal(events[1].documentId, "shirt_1");
  assert.equal(events[1].revision, 1);
  assert.equal(events[2].type, "document.upserted");
  assert.equal(events[2].revision, 2);
  assert.equal(typeof events[2].cursor, "string");
  assert.equal("sequence" in events[2], false);
  assert.deepEqual(
    (await database.forTenant("default").events.read({
      collection: "products",
      after: events[1].cursor,
    })).map((event) => event.eventId),
    [events[2].eventId],
  );
  assert.equal(created.schemaVersion, 1);
});

test("database validates documents against registered collection schemas", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "products",
        version: 1,
        activate: true,
        fields: [
          { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
          { name: "price", field: { _tag: "NumberField", label: "Price", required: true, min: 0 } },
          { name: "status", field: { _tag: "TextField", label: "Status", required: true } },
        ],
      },
    ],
  });

  await database.forTenant("default").documents.createCollection({ name: "products" });

  assert.throws(
    () =>
      database.forTenant("default").documents.insert({
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

  const valid = await database.forTenant("default").documents.insert({
    collection: "products",
    data: {
      name: "Working product",
      price: 25,
      status: "published",
    },
  });

  assert.equal(valid.schemaVersion, 1);
});

test("database schema validation reports structural issues", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "products",
        version: 1,
        activate: true,
        fields: [
          { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
          { name: "price", field: { _tag: "NumberField", label: "Price", required: true, min: 0 } },
        ],
      },
    ],
  });

  const result = database.schemas.validate("products", {
    name: "hello",
    price: -5,
    extra: true,
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.valid, false);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.some((i) => i.path.includes("price")));
  assert.ok(result.issues.some((i) => i.path.includes("extra")));
});

test("database can activate newer schema versions for later writes", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "products",
        version: 1,
        activate: true,
        fields: [
          { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
        ],
      },
    ],
  });

  await database.forTenant("default").documents.createCollection({ name: "products" });

  const created = await database.forTenant("default").documents.insert({
    collection: "products",
    id: "product_1",
    data: { name: "First version" },
  });

  assert.equal(created.schemaVersion, 1);

  await database.schemas.save({
    collection: "products",
    version: 2,
    fields: [
      { name: "name", field: { _tag: "TextField", label: "Name", required: true } },
      { name: "status", field: { _tag: "TextField", label: "Status", required: true } },
    ],
  });
  await database.schemas.activate("products", 2);

  await assert.rejects(() =>
    database.forTenant("default").documents.update({
      collection: "products",
      id: created.id,
      data: { name: "Missing status" },
      mode: "replace",
    }),
  );

  const updated = await database.forTenant("default").documents.update({
    collection: "products",
    id: created.id,
    data: { name: "Second version", status: "draft" },
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

test("database schemas can validate file reference fields natively", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "assets",
        version: 1,
        activate: true,
        fields: [
          { name: "title", field: { _tag: "TextField", label: "Title", required: true } },
          { name: "image", field: { _tag: "ImageField", label: "Image", required: true, accept: ["image/png"] } },
        ],
      },
    ],
  });

  await database.forTenant("default").documents.createCollection({ name: "assets" });

  const created = await database.forTenant("default").documents.insert({
    collection: "assets",
    data: {
      title: "Logo",
      image: {
        kind: "file",
        path: "branding/logo.png",
        href: "/zelavis/api/v1/storage/files/branding/logo.png",
        metadataHref: "/zelavis/api/v1/storage/files/branding/logo.png?format=metadata",
        contentType: "image/png",
        size: 512,
      },
    },
  });

  assert.equal(created.schemaVersion, 1);

  assert.throws(
    () =>
      database.forTenant("default").documents.insert({
        collection: "assets",
        data: {
          title: "PDF",
          image: {
            kind: "file",
            path: "doc.pdf",
            href: "/zelavis/api/v1/storage/files/doc.pdf",
            metadataHref: "/zelavis/api/v1/storage/files/doc.pdf?format=metadata",
            contentType: "application/pdf",
          },
        },
      }),
    (error) => {
      assert.equal(error.name, "DatabaseSchemaValidationError");
      assert.match(error.message, /image\/png/);
      return true;
    },
  );
});

test("database schema validation supports the expanded field catalog", async () => {
  const database = await createDatabase({
    schemas: [
      {
        collection: "articles",
        version: 1,
        activate: true,
        fields: [
          { name: "title", field: { _tag: "TextField", label: "Title", required: true, minLength: 3 } },
          { name: "slug", field: { _tag: "SlugField", label: "Slug", required: true } },
          { name: "status", field: { _tag: "SelectField", label: "Status", required: true, options: ["draft", "published"] } },
          { name: "tags", field: { _tag: "MultiSelectField", label: "Tags", required: false, options: ["news", "guide"], maxItems: 2 } },
          { name: "views", field: { _tag: "IntegerField", label: "Views", required: true, min: 0 } },
          { name: "publishedAt", field: { _tag: "DateTimeField", label: "Published At", required: true } },
          { name: "canonicalUrl", field: { _tag: "UrlField", label: "Canonical URL", required: false } },
          { name: "author", field: { _tag: "ReferenceField", label: "Author", required: true, collection: "authors" } },
          { name: "metadata", field: { _tag: "JsonField", label: "Metadata", required: false } },
          { name: "sections", field: { _tag: "RepeaterField", label: "Sections", required: false, minItems: 1, fields: [
            { name: "heading", field: { _tag: "TextField", label: "Heading", required: true } },
          ] } },
        ],
      },
    ],
  });

  const valid = database.schemas.validate("articles", {
    title: "Hello",
    slug: "hello-world",
    status: "published",
    tags: ["news"],
    views: 10,
    publishedAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://example.com/hello-world",
    author: { collection: "authors", id: "author_1" },
    metadata: { featured: true },
    sections: [{ heading: "Intro" }],
  });

  assert.equal(valid.valid, true);

  const baseDocument = {
    title: "Hello",
    slug: "hello-world",
    status: "published",
    tags: ["news"],
    views: 10,
    publishedAt: "2026-01-01T00:00:00.000Z",
    canonicalUrl: "https://example.com/hello-world",
    author: { collection: "authors", id: "author_1" },
    metadata: { featured: true },
    sections: [{ heading: "Intro" }],
  };
  const invalidCases = [
    ["title", { title: "Hi" }],
    ["slug", { slug: "Hello World" }],
    ["status", { status: "archived" }],
    ["tags", { tags: ["news", "guide", "extra"] }],
    ["views", { views: 1.5 }],
    ["publishedAt", { publishedAt: "not-a-date" }],
    ["canonicalUrl", { canonicalUrl: "nope" }],
    ["author", { author: { collection: "users", id: "author_1" } }],
    ["sections", { sections: [] }],
  ];

  for (const [fieldName, patch] of invalidCases) {
    const invalid = database.schemas.validate("articles", {
      ...baseDocument,
      ...patch,
    });
    assert.equal(invalid.valid, false, `${fieldName} should be invalid`);
    assert.ok(
      invalid.issues.some((issue) => issue.path.includes(fieldName)),
      `${fieldName} should report a field-scoped issue`,
    );
  }
});

test("database deduplicates repeated event appends by idempotency key", async () => {
  const database = await createDatabase();

  const first = await database.forTenant("default").events.append({
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

  const repeated = await database.forTenant("default").events.append({
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

  const events = await database.forTenant("default").events.read({ collection: "products" });

  assert.equal(repeated.eventId, first.eventId);
  assert.equal(repeated.idempotencyKey, "create-products");
  assert.equal(events.length, 1);
});

test("database rejects conflicting event appends for the same idempotency key", async () => {
  const database = await createDatabase();

  await database.forTenant("default").events.append({
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
      database.forTenant("default").events.append({
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

  assert.throws(() => database.forTenant("default").timeseries.get("unknown"), /is not defined/);

  await assert.rejects(
    () => database.forTenant("default").timeseries.get("metrics").range(),
    /does not define an event mapper yet/,
  );

  await assert.rejects(
    () =>
      database.forTenant("default").timeseries.get("metrics").aggregate({
        op: "avg",
      }),
    /does not define an event mapper yet/,
  );
});

test("database executes mapped time-series range and aggregate queries from events", async () => {
  const database = await createDatabase();

  await database.forTenant("default").documents.createCollection({ name: "metrics" });

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

  await database.forTenant("default").documents.insert({
    collection: "metrics",
    id: "m1",
    data: {
      timestamp: "2026-01-01T00:00:00.000Z",
      value: 10,
      metric: "cpu",
      region: "eu",
    },
  });
  await database.forTenant("default").documents.insert({
    collection: "metrics",
    id: "m2",
    data: {
      timestamp: "2026-01-01T00:01:00.000Z",
      value: 20,
      metric: "cpu",
      region: "eu",
    },
  });
  await database.forTenant("default").documents.insert({
    collection: "metrics",
    id: "m3",
    data: {
      timestamp: "2026-01-01T00:02:00.000Z",
      value: 30,
      metric: "cpu",
      region: "us",
    },
  });

  const range = await database.forTenant("default").timeseries.get("metrics").range({
    start: "2026-01-01T00:00:30.000Z",
    end: "2026-01-01T00:02:00.000Z",
    order: "desc",
  });

  assert.deepEqual(
    range.map((point) => point.value),
    [30, 20],
  );
  assert.deepEqual(range[0].tags, { metric: "cpu" });

  const avg = await database.forTenant("default").timeseries.get("metrics").aggregate({
    op: "avg",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-01T00:02:00.000Z",
  });
  const sum = await database.forTenant("default").timeseries.get("metrics").aggregate({
    op: "sum",
  });
  const count = await database.forTenant("default").timeseries.get("metrics").aggregate({
    op: "count",
    start: "2026-01-01T00:01:00.000Z",
  });

  assert.equal(avg, 20);
  assert.equal(sum, 60);
  assert.equal(count, 2);
});

test("parseWriteTargetTable extracts table names from DML and DDL write statements", () => {
  // DML — bare identifiers
  assert.equal(parseWriteTargetTable("INSERT INTO products VALUES (?)"), "products");
  assert.equal(parseWriteTargetTable("INSERT OR REPLACE INTO products VALUES (?)"), "products");
  assert.equal(parseWriteTargetTable("REPLACE INTO products VALUES (?)"), "products");
  assert.equal(parseWriteTargetTable("UPDATE products SET name = ?"), "products");
  assert.equal(parseWriteTargetTable("UPDATE OR IGNORE products SET name = ?"), "products");
  assert.equal(parseWriteTargetTable("DELETE FROM products WHERE id = ?"), "products");

  // DML — double-quoted identifiers (quoteIdentifier output)
  assert.equal(parseWriteTargetTable('INSERT INTO "Fruits" VALUES (?)'), "Fruits");
  assert.equal(parseWriteTargetTable('UPDATE "My Collection" SET data_json = ?'), "My Collection");
  assert.equal(parseWriteTargetTable('DELETE FROM "items" WHERE tenant_id = ?'), "items");

  // DML — quoted identifiers with escaped quotes
  assert.equal(parseWriteTargetTable('INSERT INTO "A""B" VALUES (?)'), 'A"B');

  // DML — schema-qualified
  assert.equal(parseWriteTargetTable('INSERT INTO main."Fruits" VALUES (?)'), "Fruits");
  assert.equal(parseWriteTargetTable("INSERT INTO main.products VALUES (?)"), "products");

  // DDL
  assert.equal(parseWriteTargetTable('DROP TABLE "Fruits"'), "Fruits");
  assert.equal(parseWriteTargetTable('DROP TABLE IF EXISTS "Fruits"'), "Fruits");
  assert.equal(parseWriteTargetTable('ALTER TABLE "Fruits" ADD COLUMN foo TEXT'), "Fruits");

  // Comments and CTE column lists cannot hide the mutation target.
  assert.equal(
    parseWriteTargetTable(
      '/* audit */ WITH cte(x) AS (SELECT 1) DELETE FROM "Fruits" WHERE tenant_id = ?',
    ),
    "Fruits",
  );
  assert.equal(
    parseWriteTargetTable(
      'WITH one(x) AS (SELECT 1), two(y) AS (SELECT x FROM one) UPDATE products SET name = ?',
    ),
    "products",
  );

  // Leading whitespace and mixed case
  assert.equal(parseWriteTargetTable("  insert into Products values (?)"), "Products");

  // Read-only — should return null
  assert.equal(parseWriteTargetTable("SELECT * FROM products"), null);
  assert.equal(parseWriteTargetTable("CREATE TABLE products (id TEXT)"), null);
  assert.equal(parseWriteTargetTable("PRAGMA table_info(products)"), null);
  assert.equal(parseWriteTargetTable("SELECT '; DELETE FROM products'"), null);
});
