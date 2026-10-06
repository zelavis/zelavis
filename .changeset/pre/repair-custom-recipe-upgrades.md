---
"zelavis": patch
"@zelavis/ui": patch
---

Fix custom recipe upgrades to freeze and execute the selected version, including relative imports, and restore the previous recipe and host descriptor when preparation fails. Allow exact-Project deletion after provisioning fails before a descriptor exists while preserving genuine cleanup errors. Refresh failed dashboard actions and show pending deletion with disabled lifecycle controls and explicit Retry deletion.
