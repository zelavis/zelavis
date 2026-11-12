# Supported storage engines

Owner decision: 2026-10-30. The official persistent engines are Node SQLite
(default), LMDB and RocksDB. Remove both libSQL targets, their public package
exports, peer/dev dependencies and configuration. Do not add a compatibility
alias, quietly substitute SQLite, or replace them with Turso Database.

The reason is maintenance cost and architectural fit, rather than an assumption
that an acquisition makes software unusable. Supabase announced its acquisition
of Turso on [October 2, 2026](https://supabase.com/blog/supabase-is-acquiring-turso)
and said existing customers continue. The [libSQL project](https://github.com/tursodatabase/libsql#readme)
still describes itself as maintained, but directs new feature development to
Turso's separate Rust implementation. [Turso's own FAQ](https://github.com/tursodatabase/turso#how-is-turso-database-different-from-tursos-libsql)
says that implementation replaces libSQL as its intended direction.

Zelavis uses ordered KV storage and owns replication, routing and fencing above
the engine boundary. Maintaining another SQLite binding, its native packaging
and remote SQL protocol offers insufficient distinct value for that work. Keep
the engine boundary open; future adapters need a concrete benefit and must pass
conditional commit, snapshot, conformance and crash-recovery qualification.
Never treat a storage engine's replication or concurrency features as a second
placement/writer authority.

Published historical changelog entries and explicitly historical benchmark data
remain history, not a list of supported engines. Current docs, CLI/SDK types,
runtime selection and marketing must name only the supported engines. No
existing database is automatically converted or deleted by this removal.
