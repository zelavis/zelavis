# Replication, Load Balancing, Consistency & ACID — Conversation Notes

This document captures the full conceptual discussion between the user and ChatGPT
about distributed databases, replication, load balancing, multi‑master systems,
consistency models, and ACID guarantees.

---

## 1. Replication vs Load Balancing

**Key idea:**  
Replication and load balancing are related but distinct.

- **Replication**
  - Keeps multiple copies of the same data
  - Enables fault tolerance, durability, and read scalability
- **Load Balancing**
  - Decides _which node_ should handle a request
  - Focuses on performance and traffic distribution

Replication enables load balancing, but is not itself a load balancer.

---

## 2. Multi‑Master Databases and Load Balancing

In a **multi‑master (multi‑leader)** database:

- Every node can accept reads and writes
- Data is replicated across nodes
- Clients may connect to any node

This allows natural distribution of load, but:

- Replication does **not** decide where traffic goes
- Routing logic is still required (client‑side or internal)
- Writes incur replication overhead and conflict handling

**Mental model:**

- Replication answers _“Can any node handle this?”_
- Load balancing answers _“Which node should handle this now?”_

---

## 3. Designing Replication + Load Balancing as One System

When building a database from scratch (e.g., in JavaScript):

Yes — replication and load balancing can be designed as a **unified system**, but you must still solve:

1. Request admission (which node accepts requests)
2. State synchronization (replication protocol)
3. Conflict semantics
4. Failure detection and recovery

A common pattern:

- Every node can accept requests
- Nodes gossip load and health
- Overloaded nodes forward requests
- Replication ensures correctness

Real systems using this idea:

- Dynamo / DynamoDB
- Cassandra
- Riak
- CouchDB

---

## 4. Consistency & Conflict Models

| Model                | Result                               |
| -------------------- | ------------------------------------ |
| Strong consistency   | Slower, coordination‑heavy           |
| Eventual consistency | Faster, conflicts possible           |
| CRDT‑based           | Automatic merges, limited data types |
| Last‑write‑wins      | Simple, lossy                        |

Important distinction:

- **Consistency level** (coordination / ordering)
- **Conflict resolution** (what happens on concurrent writes)

These are orthogonal and should not be conflated.

---

## 5. UI / Dashboard Idea: User‑Selectable Consistency

Providing users a switch or dropdown to choose consistency is **valid and modern** —
_if done honestly_.

Recommended:

- Scope the choice per operation, collection, or namespace
- Avoid pretending a global toggle magically changes everything

Best abstraction:

- **Strong (ACID, coordinated)**
- **Eventual (high availability, async)**

Never imply eventual consistency is “just faster ACID”.

---

## 6. Can a Multi‑Master Database Be ACID?

**Yes, but with strict limits.**

ACID in distributed systems requires:

- Global ordering of writes
- Coordination via consensus (Raft / Paxos)
- Blocking under network partitions

ACID multi‑master systems exist:

- Google Spanner
- CockroachDB
- YugabyteDB

Trade‑offs:

- Higher latency
- Reduced availability under partitions
- “Multi‑master” is logical, not free‑for‑all writes

---

## 7. Eventual Consistency vs ACID (Final Conclusion)

**Eventual consistency can never be fully ACID.**

Why:

- Violates global consistency and isolation
- Allows temporary invalid states
- Relies on conflict resolution after the fact

However:

- Durability often still holds
- Per‑node atomicity may hold

Therefore:

- **Strong consistency mode ⇒ ACID**
- **Eventual consistency mode ⇒ NOT ACID**

---

## 8. Final Design Takeaway

A clean, honest database design:

- Offer **Strong (ACID)** and **Eventual** modes
- Clearly define guarantees of each
- Enforce semantics rigorously
- Educate users instead of hiding trade‑offs

This approach aligns with distributed systems theory and real‑world databases.

---

## SDKs as Cluster Members

A key architectural insight for Zelavis is that **every SDK—browser, server, or future environments—is a full cluster member**. Whether running in a datacenter, a user's browser, or any supported environment, every Zelavis instance participates in the cluster using the same primitives and protocols.

### Why This Matters

- **Offline-first:** For example, the browser SDK uses IndexedDB for local storage and can operate fully offline. When reconnected, it syncs with the rest of the cluster. Other SDKs (e.g., Node.js, Bun) use their own local storage backends but follow the same cluster logic.
- **Uniformity:** The same cluster logic powers all Zelavis SDKs—browser, server, and beyond. No special cases.
- **Scalability:** From a solo developer with a $4 VPS to a global, multi-region deployment, the cluster codebase and API remain the same across all SDKs.

### Example Topologies

#### Smallest possible setup

```
┌─────────────────┐         ┌─────────────────┐
│  Zelavis       │         │  Zelavis       │
│  (Browser)      │◄───────►│  ($4 VPS)       │
│  IndexedDB      │  sync   │  SQLite         │
└─────────────────┘         └─────────────────┘
     Node A                      Node B
```

#### Large-scale deployment

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│  100 Browsers   │◄──►│  10 Servers     │◄──►│  3 Datacenters  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Scaling Table

| Scale  | Setup                  | Cluster behavior                   |
| ------ | ---------------------- | ---------------------------------- |
| Tiny   | 1 browser + 1 VPS      | 2-node cluster, offline-first sync |
| Small  | 10 users + 1 server    | 11-node cluster                    |
| Medium | 1000 users + 3 servers | 1003-node cluster, load balanced   |
| Large  | Global + multi-region  | Same primitives, same API          |

### Design Implications

- **Cluster is always present:** Even the smallest app uses the cluster layer under the hood.
- **No “client” vs “server” split:** The browser Zelavis is a peer, not a second-class client.
- **Seamless scaling:** Developers start small and scale up without changing code or architecture.
- **Cluster code lives in core:** Not an enterprise add-on, but a fundamental part of Zelavis.

### Security Implication: User Data Isolation

While SDKs are full cluster members, **client SDKs (such as those running in browsers or on user devices) only replicate and sync data that is owned by, or accessible to, the logged-in user**. Data written by one user is never replicated to another user's client SDK. This ensures:

- **User data privacy:** No accidental cross-user data leakage.
- **Access control:** Each client only syncs its own data or data it is authorized to access.
- **Cluster membership ≠ universal replication:** Being a cluster member does not mean receiving all data—replication is filtered by user ownership and permissions.

This security model is fundamental to Zelavis and must be enforced in all SDK implementations.

**This is the Zelavis vision:** true peer-to-peer, offline-first, and scalable from the smallest to the largest deployments—all with a unified cluster architecture.

---

_End of notes._
