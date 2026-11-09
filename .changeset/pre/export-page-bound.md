---
"zelavis": minor
---

An export page now holds at most `limit` entries in all: a divided Tenant's parts share it, a fair share each, starting each call where the last stopped, and the cursor's bound grows with the number of parts. A divided Tenant's restore that fails after earlier parts were restored answers `DividedRestoreIncomplete`, naming the parts restored and that a `purge` restore completes it.
