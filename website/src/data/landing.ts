export interface PlatformTab {
	readonly id: string;
	readonly eyebrow: string;
	readonly title: string;
	readonly body: string;
	readonly link: string;
	readonly linkLabel: string;
	readonly highlights: readonly string[];
}

export interface AgenticAction {
	readonly label: string;
	readonly href: string;
}

export interface AgenticMetric {
	readonly label: string;
	readonly value: string;
	readonly hint: string;
}

export interface AgenticFeature {
	readonly id: string;
	readonly label: string;
	readonly badge: string;
	readonly userPrompt: string;
	readonly agentStatus: string;
	readonly agentSteps: readonly string[];
	readonly agentReply: string;
	readonly actionPills: readonly AgenticAction[];
	readonly codeTitle: string;
	readonly codeSnippet: string;
	readonly metrics: readonly AgenticMetric[];
}

export interface DataLens {
	readonly title: string;
	readonly perf: string;
	readonly code: string;
}

export interface ArchitectureCapability {
	readonly id: string;
	readonly number: string;
	readonly label: string;
	readonly title: string;
	readonly body: string;
	readonly accent: string;
}

export const platformTabs: readonly PlatformTab[] = [
	{
		id: 'apps',
		eyebrow: 'Apps',
		title: 'Projects that start production-ready',
		body: 'Create isolated projects with their runtime, version, services, and data boundary already locked. Every project runs in its own process envelope without touching the parent platform.',
		link: '/architecture/project-model/',
		linkLabel: 'Explore the project model',
		highlights: [
			'Isolated child runtime (Node process or container)',
			'Recipe version locking prevents silent breakages',
			'Project Gateway handles auth and proxying',
		],
	},
	{
		id: 'data',
		eyebrow: 'Data',
		title: 'One object, many useful lenses',
		body: 'Write once through the documents API and query document, column, measure, and graph projections. All lenses share one partition-local identifier space for instant zero-exchange joins.',
		link: '/api/database/',
		linkLabel: 'Read the database API',
		highlights: [
			'Single payload projected into 4 data models',
			'Deterministic event-log replication stream',
			'Pluggable engines: SQLite, RocksDB, LMDB',
		],
	},
	{
		id: 'workloads',
		eyebrow: 'Workloads',
		title: 'Code that lives beside the product',
		body: 'Run project-scoped functions, jobs, schedules, and webhooks in the long-running Zelavis runtime. No cold starts, external workers, or third-party cron services needed.',
		link: '/packages/app/',
		linkLabel: 'Learn about workloads',
		highlights: [
			'Cron schedules and background queue workers',
			'Typed webhooks with automatic signature verification',
			'Shared state and direct database tenant context',
		],
	},
	{
		id: 'hosting',
		eyebrow: 'Hosting',
		title: 'Your server is a first-class target',
		body: 'Host websites on infrastructure you control, with domains, logs, backups, and lifecycle operations in one place. Managed deploy providers remain optional adapters.',
		link: '/architecture/project-model/',
		linkLabel: 'Inspect hosting architecture',
		highlights: [
			'Automated SSL certificates via Let’s Encrypt',
			'Zero-downtime rolling deploys and rollbacks',
			'Built-in reverse proxy and edge routing',
		],
	},
	{
		id: 'content',
		eyebrow: 'Content',
		title: 'Structured content without another system',
		body: 'Model content types, entries, schemas, and media on top of the same tenant-aware data foundation. Deliver headless JSON to any frontend or Fuzor site.',
		link: '/packages/app/',
		linkLabel: 'Explore content features',
		highlights: [
			'Visual schema modeler with typed field definitions',
			'Built-in media storage with image transformation',
			'Tenant-partitioned collections and drafts',
		],
	},
];

export const agenticFeatures: readonly AgenticFeature[] = [
	{
		id: 'app',
		label: 'App Creation',
		badge: 'Recipe Lock',
		userPrompt:
			'Zelavis, spin up a multi-tenant B2B workspace called "Northstar". Lock it to the latest Zelavis App recipe with 4 physical shards, an isolated Node process envelope, and a Fuzor marketing storefront.',
		agentStatus: 'Fabric Verified · Generation Lease Acquired',
		agentSteps: [
			'Provisioned project recipe @zelavis/app@1.0.4 (locked)',
			'Configured 64 virtual shard ranges across 4 SQLite files',
			'Mounted Project Gateway proxy at /projects/northstar/*',
			'Initialized isolated Node child process (pid: 14920)',
		],
		agentReply:
			'Northstar is ready in production-isolated mode. The runtime version is locked in your project’s System Store so future platform updates will never cause silent breakages.',
		actionPills: [
			{ label: 'Open Northstar Dashboard', href: '/zelavis' },
			{ label: 'Inspect Gateway Proxy', href: '/architecture/project-model/' },
		],
		codeTitle: 'project.manifest.json · .zelavis/projects/northstar/',
		codeSnippet: `{
  "project": "northstar",
  "recipe": {
    "name": "@zelavis/app",
    "version": "1.0.4",
    "locked": true
  },
  "runtime": {
    "driver": "node-process",
    "pid": 14920,
    "envelope": "isolated"
  },
  "topology": {
    "physical_shards": 4,
    "virtual_ranges": 64,
    "router": "hash(tenant_id)"
  },
  "gateway": {
    "route": "/projects/northstar/*",
    "auth": "crypto-token"
  }
}`,
		metrics: [
			{ label: 'Virtual Shards', value: '64 ranges', hint: '4 physical SQLite files' },
			{ label: 'Runtime Isolation', value: 'PID 14920', hint: 'Zero parent leaks' },
			{ label: 'Gateway Routing', value: 'Active', hint: 'Sub-millisecond proxy' },
		],
	},
	{
		id: 'database',
		label: 'Database & Schema',
		badge: '4 Lenses',
		userPrompt:
			'Zelavis, create an "orders" collection in Northstar. Include customer ID, total, items, and status. Enable columnar projections for analytics, time-series revenue metrics, and listen to order creation events.',
		agentStatus: 'Schema Validated · Event Stream Appended',
		agentSteps: [
			'Registered "orders" collection in System Store',
			'Configured Document lens (nested JSON) & Column lens (aggregates)',
			'Provisioned Measure lens rollups (orders.volume, orders.revenue)',
			'Attached append-only replication stream cursor',
		],
		agentReply:
			'The "orders" collection is live across all 4 shards. A single write to the documents API is automatically projected into 4 data lenses with zero data duplication.',
		actionPills: [
			{ label: 'Open Database Studio', href: '/api/database/' },
			{ label: 'Inspect Event Stream', href: '/api/database/' },
		],
		codeTitle: 'orders.projection.ts · Multi-Model Lenses',
		codeSnippet: `// 1 single write -> 4 simultaneous lenses
await db.forTenant("acme").documents.put({
  collection: "orders",
  id: "ord_8921",
  customer: "cust_901",
  total: 489.00,
  currency: "USD",
  status: "confirmed",
  items: [{ sku: "zl-scale", qty: 2, price: 244.50 }]
});

// Column lens query for instant zero-exchange aggregations:
const stats = await db.forTenant("acme").columns("orders").aggregate({
  sum: "total",
  groupBy: "status"
});`,
		metrics: [
			{ label: 'Origin Write', value: 'documents.put()', hint: 'Single source of truth' },
			{ label: 'Data Lenses', value: '4 Active', hint: 'Doc, Col, Measure, Graph' },
			{ label: 'Replication', value: '0.4ms WAL', hint: 'Deterministic stream' },
		],
	},
	{
		id: 'auth',
		label: 'Users & Auth',
		badge: 'Passkeys & RBAC',
		userPrompt:
			'Zelavis, invite "marcus@acme.com" as an Auditor. Enforce hardware passkeys via WebAuthn, grant read-only access to orders and workloads, and strictly block billing access.',
		agentStatus: 'Cryptographic Identity Registered · RBAC Enforced',
		agentSteps: [
			'Created user principal in Platform Identity Subsystem',
			'Enforced WebAuthn / Passkey hardware credential policy',
			'Generated fine-grained RBAC rule matrix with billing denial',
			'Dispatched signed cryptographic invitation link (expires 24h)',
		],
		agentReply:
			'Marcus has been invited with enforced passkeys. The RBAC policy denies billing and restricts all database reads to tenant "acme" without exposing parent platform grants.',
		actionPills: [
			{ label: 'View Team Permissions', href: '/architecture/access-control/' },
			{ label: 'Audit Active Sessions', href: '/architecture/access-control/' },
		],
		codeTitle: 'rbac.policy.json · Identity Subsystem',
		codeSnippet: `{
  "principal": "usr_marcus_77",
  "email": "marcus@acme.com",
  "role": "auditor",
  "auth_policy": {
    "enforce_passkey": true,
    "webauthn_uv": "preferred"
  },
  "grants": {
    "allow": ["database:read:orders", "workloads:view", "logs:read"],
    "deny": ["billing:*", "server:*", "admin:*"]
  },
  "tenant_boundary": "tenant_acme"
}`,
		metrics: [
			{ label: 'Auth Provider', value: 'WebAuthn / Passkeys', hint: 'Hardware-backed keys' },
			{ label: 'Permission Check', value: '0.05ms', hint: 'In-memory token check' },
			{ label: 'Session Security', value: 'Cryptographic', hint: 'Hardware bound' },
		],
	},
	{
		id: 'content',
		label: 'Content & Media',
		badge: 'Headless CMS',
		userPrompt:
			'Zelavis, create a "Documentation Article" content model with title, slug, lexical markdown body, author relation, and automatic WebP image compression with 2x retina thumbnails.',
		agentStatus: 'Content Schema Created · Media Pipeline Ready',
		agentSteps: [
			'Created typed schema "documentation_articles"',
			'Mounted asset bucket with Sharp on-the-fly WebP converter',
			'Generated typed TypeScript SDK client & Headless REST route',
			'Indexed slug field for sub-millisecond static site generation',
		],
		agentReply:
			'Documentation Article schema is published. Your frontend can fetch content via headless REST or use the generated TypeScript SDK with full compile-time type safety.',
		actionPills: [
			{ label: 'Open Content Editor', href: '/packages/app/' },
			{ label: 'View REST Endpoints', href: '/packages/app/' },
		],
		codeTitle: 'schema.content.ts · Headless API',
		codeSnippet: `import { defineContentType } from "zelavis/content";

export const DocArticle = defineContentType({
  name: "documentation_articles",
  fields: {
    title: { type: "string", required: true },
    slug: { type: "slug", unique: true },
    body: { type: "richText", format: "markdown" },
    author: { type: "relation", target: "users" },
    coverImage: {
      type: "media",
      transform: { format: "webp", widths: [320, 640, 1280] }
    }
  }
});`,
		metrics: [
			{ label: 'Media Pipeline', value: 'Auto-WebP', hint: 'Sharp image engine' },
			{ label: 'Delivery', value: 'Headless REST', hint: 'Zero layout coupling' },
			{ label: 'Type Safety', value: 'Generated SDK', hint: 'Compile-time verified' },
		],
	},
	{
		id: 'workloads',
		label: 'Workloads & Crons',
		badge: 'In-Runtime',
		userPrompt:
			'Zelavis, listen to Stripe "checkout.session.completed" webhooks, verify the HMAC signature, update the tenant subscription, and run a nightly inventory reconciliation at 2 AM UTC.',
		agentStatus: 'Webhook Registered · Cron Job Scheduled',
		agentSteps: [
			'Registered POST /webhooks/stripe-checkout with HMAC verification',
			'Mounted nightlyReconciliation cron ("0 2 * * *") in runtime scheduler',
			'Bound tenant database transaction context to event payload',
			'Configured automated retry queue with exponential backoff',
		],
		agentReply:
			'Stripe webhook and 2 AM nightly reconciliation are active inside the long-running Zelavis runtime. No external AWS Lambda or Celery workers required.',
		actionPills: [
			{ label: 'View Workload Monitor', href: '/packages/app/' },
			{ label: 'Trigger Test Event', href: '/packages/app/' },
		],
		codeTitle: 'workloads.config.ts · In-Runtime Scheduling',
		codeSnippet: `import { defineWebhook, defineWorkload } from "zelavis/workload";

export const stripeWebhook = defineWebhook({
  path: "/webhooks/stripe-checkout",
  secretEnv: "STRIPE_SECRET",
  async handle({ event, db }) {
    if (event.type === "checkout.session.completed") {
      const tenantId = event.data.metadata.tenantId;
      await db.forTenant(tenantId).documents.patch("tenants", tenantId, {
        plan: "enterprise",
        active: true
      });
    }
  }
});

export const nightlyReconciliation = defineWorkload({
  schedule: "0 2 * * *", // 2 AM UTC daily
  async run({ db, logger }) {
    logger.info("Executing shard-wide tenant audit...");
  }
});`,
		metrics: [
			{ label: 'Cold Start', value: '0.0ms', hint: 'Long-running runtime' },
			{ label: 'Webhook Signature', value: 'HMAC-SHA256', hint: 'Auto-verified' },
			{ label: 'Database Latency', value: 'Direct memory', hint: 'No HTTP roundtrip' },
		],
	},
];

export const dataLenses: Record<string, DataLens> = {
	document: {
		title: 'Document Projection (JSON Store)',
		perf: '0.12ms query',
		code: `// Projected Document Lens
{
  "id": "ord_102",
  "tenant_id": "acme",
  "customer": "c_88",
  "total": 420.00,
  "items": [{ "sku": "ZEL-10", "qty": 2, "unitPrice": 210.00 }],
  "_version": 1,
  "_cursor": "0000000000000001"
}`,
	},
	column: {
		title: 'Column Lens (Vectorized Fast Intersections)',
		perf: '0.04ms scan',
		code: `// Columnar Scan & Filter (zero row deserialization)
SCAN columns ["id", "total", "customer"]
WHERE customer == "c_88" AND total > 100.00
-> match bitset: 0b0000000000000001
-> result: [{ id: "ord_102", total: 420.00 }] (evaluated via SIMD vector)`,
	},
	measure: {
		title: 'Measure Lens (Time-Series Rollup)',
		perf: '0.08ms rollup',
		code: `// Time-Series Metric Signal
ROLLUP metric "orders.gmv" BUCKET 1h
[2026-09-13T19:00:00Z] total: $3,210.00 (7 events)
[2026-09-13T20:00:00Z] total: $420.00   (1 event: ord_102) -> projected in real-time`,
	},
	graph: {
		title: 'Graph Lens (Connected Entity Records)',
		perf: '0.16ms hop',
		code: `// Graph Lens Entity Pointers
(Customer: c_88)
  --[:PLACED_ORDER { at: 1726250520 }]-> (Order: ord_102)
  --[:INCLUDES_ITEM { qty: 2 }]-> (CatalogItem: ZEL-10)
  --[:SHIPPED_BY]-> (Carrier: "dhl-express")`,
	},
};

export const architectureCapabilities: readonly ArchitectureCapability[] = [
	{
		id: 'database',
		number: '01',
		label: 'Database',
		title: 'Sharded from the first project',
		body: 'Every official Zelavis App routes stable virtual ranges across physical shards—even when they all live on one node. Scaling out simply redistributes shard placements rather than changing your application model.',
		accent: 'blue',
	},
	{
		id: 'fabric',
		number: '02',
		label: 'Platform Fabric',
		title: 'Placement is authority, not a URL',
		body: 'The control plane owns nodes, allocation, routing, generation fencing, and lifecycle orchestration. Project runtimes execute in bounded envelopes and never become the scheduling authority.',
		accent: 'violet',
	},
	{
		id: 'surfaces',
		number: '03',
		label: 'Open surfaces',
		title: 'Use the dashboard—or do not',
		body: 'Stable endpoints and typed SDK boundaries keep every capability open to CLIs, coding agents, background scripts, custom frontends, and external automation tools without lock-in.',
		accent: 'coral',
	},
];
