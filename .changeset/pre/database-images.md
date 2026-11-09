---
"zelavis": minor
---

Add database images: a physical backup of the whole database made through the ordered key-value interface alone, so any engine images into any other. `db.maintenance.image(destination)` copies every shard (topology and global included) from one snapshot each into an empty engine; on a Node host `POST database/maintenance/images` (`{ name, engine? }`), `GET database/maintenance/images`, `client.projects.createDatabaseImage` and `databaseImages`, and `zelavis projects create-image <id> <name> [--storage sqlite|lmdb|rocksdb|libsql]` and `images <id>` write it as an ordinary shard directory under the database's `images/` folder, named, renamed into place only once whole. An image opens as a database in the engine it was written in. There is deliberately no restore route: replacing the live database is the operator's, with the Project stopped. All need `database.backup`.
