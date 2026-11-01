---
"zelavis": minor
---

Remove the libSQL and remote libSQL storage adapters, public subpaths, optional peers and configuration. SQLite remains the default; LMDB and RocksDB remain optional. Unsupported engine names are refused explicitly rather than falling back to another engine. Replication continues through Zelavis's engine-neutral event log.
