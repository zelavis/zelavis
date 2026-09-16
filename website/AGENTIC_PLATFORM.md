# Zelavis — The Agentic App Platform

> **Plan, build, and manage apps together, from first ticket to production.**<br>
> Everything from database schemas to auth roles, background workloads, and full app creation can be commanded conversationally through AI chat—backed by deterministic, production-grade infrastructure.

---

## Executive Summary: The Death of the "AI Wrapper"

Today’s software development is divided into two broken paradigms:

1. **Traditional Backend-as-a-Service (Firebase, Supabase, AWS)**: Powerful and scalable, but fragmented across dozens of web consoles, CLI commands, migration scripts, IAM policies, and disconnected SaaS vendors.
2. **AI Code-Generation Wrappers & Copilots**: Capable of writing code in an editor, but disconnected from the running production environment. They hallucinate table schemas, drift from database realities, generate non-idempotent migration scripts, and leave operators to manually wire auth providers, serverless queues, and domain routing.

**Zelavis unifies both.** It is the first platform where the developer interface is **conversational and agentic**, while the execution engine is **deterministic, self-hostable, and contract-enforced**.

Inside the Zelavis dashboard sits the **Zelavis Assistant**—a platform-native agent with direct, secure access to the Platform OS control plane, the project gateway, the multi-model database engine, and the background workload scheduler. When you tell Zelavis:

> *"Zelavis, spin up a multi-tenant B2B application with passkey authentication, an isolated database shard, and an Astro storefront."*

Zelavis does not simply spit out boilerplate code into a chat window. It **executes the change through typed platform contracts**, provisions isolated runtime envelopes, locks versioned project recipes, configures the reverse proxy gateway, and presents an interactive verification diff right in your dashboard.

---

## The 5 Conversational Pillars

Every layer of modern application development in Zelavis can be commanded via natural language through the resident Assistant:

```
                  ┌────────────────────────────────────────────────────────┐
                  │                Zelavis Assistant                       │
                  │   Native conversational agent in the Zelavis dashboard │
                  └──────────────────────────┬─────────────────────────────┘
                                             │
      ┌───────────────────┬──────────────────┼──────────────────┬──────────────────┐
      ▼                   ▼                  ▼                  ▼                  ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ 1. App       │   │ 2. Database  │   │ 3. Identity  │   │ 4. Content   │   │ 5. Workloads │
│    Creation  │   │    & Schema  │   │    & Access  │   │    & Media   │   │    & Crons   │
└──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘   └──────────────┘
```

---

### Pillar 1: Conversational App Creation & Recipe Scaffolding

Instead of memorizing flags across multiple CLIs, creating cloud buckets, and writing Dockerfiles, you prompt Zelavis to create, configure, and isolate entire application stacks.

#### Conversational Prompt
```txt
"Zelavis, create a new multi-tenant workspace called 'Northstar'. Lock it to the latest
Zelavis App recipe with 4 virtual shards, configure a Node 22 runtime envelope, and
prepare an Astro marketing storefront."
```

#### Under the Hood: What Zelavis Does
1. **Recipe Version Locking**: Locks the exact recipe `{ name: "@zelavis/app", version: "1.0.4" }` in the project runtime database (`.zelavis/runtime/zelavis.sqlite`). Future platform upgrades will never rewrite or break this project.
2. **Runtime Isolation**: Prepares an isolated process envelope under `.zelavis/projects/northstar/` with dedicated file storage, isolated memory, and non-privileged credentials.
3. **App Data Fabric Topology**: Initializes 64 virtual shard ranges routed across 4 physical SQLite shards with deterministic virtual hash mapping.
4. **Project Gateway Binding**: Mounts proxy routes under `/zelavis/projects/northstar/*` with strict cryptographic authentication.

#### Real Dashboard Action
```json
{
  "status": "ready",
  "project": "northstar",
  "recipe": "@zelavis/app@1.0.4",
  "envelope": "process:14920",
  "data_boundary": ".zelavis/projects/northstar/.zelavis/data",
  "shards": { "physical": 4, "virtual_ranges": 64 },
  "actions": [
    { "label": "Open Project Dashboard", "to": "/projects/northstar" },
    { "label": "Inspect Gateway", "to": "/projects/northstar/gateway" }
  ]
}
```

---

### Pillar 2: Conversational Multi-Model Database & Schema Engineering

In traditional platforms, evolving a schema means drafting SQL migrations, running CLI tools, praying there are no locks, and creating separate Elasticsearch or ClickHouse clusters for analytics.

In Zelavis, the multi-model database (`zelavis/db`) is an event-sourced object engine on swappable storage (SQLite, libSQL, RocksDB, LMDB). A single document write is projected simultaneously through **document, column, measure, and graph lenses**.

#### Conversational Prompt
```txt
"Zelavis, add an 'orders' collection to the Northstar database. I need customer ID, items,
total amount, and order status. Index customer ID for point lookups, enable columnar scans
for monthly revenue aggregates, and set up an event listener for payment triggers."
```

#### Under the Hood: What Zelavis Does
1. **Schema Definition**: Registers typed collection schema in the project's System Store without downtime or exclusive table locks.
2. **Multi-Lens Projections**:
   - **Document Lens**: Provides JSON object queries and nested field lookups.
   - **Column Lens**: Projects order totals into columnar arrays for zero-exchange microsecond aggregations.
   - **Measure Lens**: Aggregates time-series metrics (`orders.volume`, `orders.revenue`).
3. **Event Stream Ingestion**: Generates an append-only event log entry with cryptographic cursor and generation fencing.
4. **Tenant Isolation**: Ensures all operations are scoped to `db.forTenant(tenantId)`.

#### Generated Code Sample
```typescript
// db.forTenant("acme").documents.put()
await db.forTenant(tenantId).documents.put({
  collection: "orders",
  id: "ord_902",
  customer: "cust_44",
  total: 289.50,
  currency: "USD",
  status: "paid",
  items: [
    { sku: "zel-pro", qty: 1, price: 289.50 }
  ],
  createdAt: new Date().toISOString()
});
```

---

### Pillar 3: Conversational Identity, Access Control & RBAC

Auth should not require setting up Auth0, wiring third-party JWT verifiers, and manually writing row-level security SQL scripts. Zelavis treats Identity & Permissions as a built-in Platform Subsystem.

#### Conversational Prompt
```txt
"Zelavis, invite 'sarah@acme.com' to the engineering team as an Auditor. Make sure
passkeys and WebAuthn are strictly enforced for her role, and block her access
to production billing records."
```

#### Under the Hood: What Zelavis Does
1. **Cryptographic Identity Management**: Creates an identity record in the Platform System Store with scoped tenant permissions.
2. **Passkey / WebAuthn Configuration**: Associates hardware security token policies with the user's principal identity.
3. **Role-Based Access Control (RBAC)**: Computes fine-grained permission grants (`database:read`, `workloads:view`, `billing:deny`).
4. **Session Token Issuance**: Dispatches a secure, single-use activation magic link with signature expiration.

#### Resulting Policy Specification
```json
{
  "user": "sarah@acme.com",
  "role": "auditor",
  "team": "engineering",
  "auth_methods": ["passkey", "webauthn"],
  "grants": [
    "projects:read",
    "database:read:orders",
    "workloads:read",
    "!billing:*"
  ],
  "enforced_by": "ZelavisPlatformAuthSubsystem"
}
```

---

### Pillar 4: Conversational Headless Content & Media Schemas

Why run a separate headless CMS like Contentful or Strapi? Zelavis provides WordPress-level content flexibility with developer-grade headless APIs.

#### Conversational Prompt
```txt
"Zelavis, define a 'Changelog Entry' content type. Include a title, publish date, version tag,
markdown body, and an author relation. Set up image transformation so uploaded screenshots
are automatically converted to WebP with responsive 2x retina thumbnails."
```

#### Under the Hood: What Zelavis Does
1. **Content Type Model**: Defines content schemas with strict validation rules stored directly on the project's data engine.
2. **Media Bucket & CDN Optimization**: Configures built-in media storage with automated WebP/AVIF compression pipelines using `sharp`.
3. **Headless JSON Endpoint**: Immediately exposes typed REST and GraphQL-compatible endpoints for consumption by any frontend (Astro, Next.js, Remix, mobile apps).

#### Headless API Output
```json
{
  "slug": "v1-0-agentic-release",
  "title": "Zelavis 1.0: The Agentic App Platform",
  "version": "1.0.4",
  "author": { "id": "usr_ivan", "name": "Ivan" },
  "media": {
    "hero": "/media/changelog-hero.webp",
    "thumbnail": "/media/changelog-hero-320w.webp"
  },
  "body_html": "<p>Plan, build, and manage apps conversationally...</p>"
}
```

---

### Pillar 5: Conversational Workloads, Background Crons & Event Webhooks

Modern apps require background processing: sending welcome emails, synchronizing billing with Stripe, running nightly reconciliation, and polling external APIs.

With Zelavis, you don't need AWS Lambda, Celery, or external cron daemons. Workloads live right inside the project runtime.

#### Conversational Prompt
```txt
"Zelavis, listen to incoming Stripe 'checkout.session.completed' webhooks, verify the
HMAC signature, update the tenant's subscription status in the database, and schedule
a nightly reconciliation job to run every midnight UTC."
```

#### Under the Hood: What Zelavis Does
1. **Webhook Endpoint Registration**: Registers typed endpoint `/webhooks/stripe` with automatic cryptographic secret verification.
2. **Runtime Cron Scheduler**: Mounts a background cron job (`0 0 * * *`) directly in the long-running Zelavis runtime process. No cold starts.
3. **Database Transaction Binding**: Executes changes directly inside the tenant's database context (`db.forTenant(event.tenantId)`).

#### Generated Workload Code
```typescript
import { defineWorkload, defineWebhook } from "zelavis/workload";

export const stripeWebhook = defineWebhook({
  path: "/webhooks/stripe",
  secretEnv: "STRIPE_WEBHOOK_SECRET",
  async handle({ event, db }) {
    if (event.type === "checkout.session.completed") {
      const tenantId = event.data.metadata.tenantId;
      await db.forTenant(tenantId).documents.patch("tenants", tenantId, {
        plan: "pro",
        status: "active"
      });
    }
  }
});

export const nightlyReconciliation = defineWorkload({
  schedule: "0 0 * * *", // midnight UTC
  async run({ db, logger }) {
    logger.info("Running automated subscription audit across shards");
    // Shard-aware reconciliation workflow
  }
});
```

---

## The Architectural Secret: Why Zelavis Makes AI Safe

Other AI tools fail because they give language models free rein to generate bash scripts, edit unversioned code, and execute arbitrary SQL commands against live databases. **Hallucinations corrupt production.**

Zelavis solves this by treating the AI not as an unconstrained root shell, but as an authenticated principal that interacts with **Typed Platform Contracts and Fenced Runtime Boundaries**:

```
                       ┌─────────────────────────────────────────┐
                       │        User Conversational Prompt       │
                       └────────────────────┬────────────────────┘
                                            │
                                            ▼
                       ┌─────────────────────────────────────────┐
                       │        Zelavis Assistant Runtime        │
                       │     Validates intent against schemas    │
                       └────────────────────┬────────────────────┘
                                            │
                                            ▼
                       ┌─────────────────────────────────────────┐
                       │        Platform Fabric Authority        │
                       │   Generation Leases & Security Fencing  │
                       └──────────┬───────────────────┬──────────┘
                                  │                   │
                                  ▼                   ▼
                     ┌─────────────────────┐ ┌─────────────────────┐
                     │ Project Envelope    │ │ Append-Only Log     │
                     │ Isolated process    │ │ Cryptographic state │
                     └─────────────────────┘ └─────────────────────┘
```

1. **Deterministic Contracts**: When the AI modifies a schema, it writes to a typed manifest. The database engine validates the manifest before applying it. If the AI suggests an invalid type, the compiler catches it before a single byte touches disk.
2. **Generation Fencing & Leases**: In a distributed deployment, only the active writer lease can commit changes. An AI agent cannot cause split-brain or stale writes.
3. **Strict Privilege Hierarchy**: *"A child knows its parent; it never becomes it."* When the Assistant operates within a project, it is bound by the Project Gateway. It cannot inspect, mutate, or compromise sibling projects or the host system.
4. **Append-Only Audit Log**: Every action performed conversationally is written to the platform event log with the user's identity, timestamp, and reversible migration diff. You can roll back any AI-generated change in one click.
5. **Model-Agnostic Freedom**: Zelavis Assistant uses an open responder contract (`ZelavisAssistantResponder`). You can plug in Anthropic Claude 3.7, OpenAI GPT-4o, local Ollama models (DeepSeek, Llama 3), or deterministic rule-based engines. Your data never leaves your infrastructure unless you explicitly configure an external LLM.

---

## Marketing Copy Snippets & Taglines

### Primary Tagline
> **Zelavis — The App Platform.**<br>
> Plan, build, and manage apps together, from first ticket to production.

### Supporting Headlines
- **"Talk to your stack. Watch it build in real time."**
- **"The first developer platform where every layer is conversational."**
- **"Backend-as-a-service meets agentic intelligence."**
- **"From database schemas to auth roles and background workloads—just ask Zelavis."**
- **"Deterministic infrastructure. Conversational agility."**

### 30-Second Elevator Pitch
> *"Zelavis is the unified app platform that brings Firebase, Vitess, and modern hosting into one self-hostable runtime. But what makes it revolutionary is that it is built from day one to be agentic. Through the built-in Zelavis Assistant, developers can scaffold multi-tenant apps, design multi-model databases, configure passkey auth, and orchestrate background workloads entirely through natural language. And because Zelavis enforces typed contracts and generation fencing, your AI will never hallucinate a broken production database."*

### Feature Comparison

| Capability | Supabase / Firebase | Cursor / Claude Code | Zelavis Agentic Platform |
|---|---|---|---|
| **Conversational Interface** | No (manual dashboard clicks) | Editor-only chat | **Native dashboard & CLI Assistant** |
| **Execution Authority** | Disjointed cloud console | Local files only (no runtime) | **Direct Platform OS & Gateway integration** |
| **Database Architecture** | Monolithic single engine | No database engine | **Event-sourced multi-model with physical/virtual sharding** |
| **Self-Hostable** | Complex multi-repo Docker setup | N/A (Desktop tool) | **Single unified binary / Node process** |
| **Safety Guarantees** | Manual DBA migration scripts | Unchecked file diffs | **Typed contracts, generation leases & event rollback** |
| **Workloads & Crons** | Separate serverless functions | Code files only | **In-runtime scheduled jobs & typed webhooks** |

---

## Summary

Zelavis transforms application development from a chore of stitching disparate SaaS tools and debugging migration scripts into an **empowering, fluid, conversational experience**.

Whether you run Zelavis on a $5/month private VPS, on your local MacBook, or across a global distributed cluster—**Zelavis is your resident senior architect, always ready to build.**
