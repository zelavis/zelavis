---
"zelavis": patch
---

An event cursor now names the life of the Tenant that issued it. Before, removing a Tenant and writing to it again let a change-feed cursor kept from before read as a place in the new log: empty pages until the new log passed its old position, then the rest, with every event before it skipped and nothing reported. Such a cursor is now refused with `CursorFromAnotherLife` (HTTP 409, `code: "cursor-from-another-life"`, through the SDK and the CLI alike), and the consumer reads the feed again from the start. A move, a follower and a copy keep the life; a branch accepts its source's cursors only from the life it was branched from, and is not merged back into a source removed and written again since. This is data layout 5: Apps on layout 4 move to it through the data-layout migration.
