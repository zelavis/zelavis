---
"zelavis": patch
"@zelavis/ui": patch
---

Fix Database sidebar tables in native Apps and managed apps' bound Zelavis backends. Load the actual Project table catalogue, retain each table's Tenant, group logical system views separately, and revalidate persisted state after creation instead of keeping a local event copy. Empty databases return an empty catalogue without inventing a Tenant.

Add Server → Database for read-only Platform System Store tables and paginated records, with secret values redacted and system-scoped `server.database.inspect` authorization. Expose matching HTTP, SDK (`client.runtime.systemStore`) and CLI (`zelavis system-store`) operations. Custom System Store adapters must implement namespace enumeration and bounded pages.
