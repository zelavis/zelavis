---
"zelavis": patch
"@zelavis/ui": patch
---

An installed app, plugin or frontend that the Marketplace now offers at a newer version shows **Update to** that version, and updating it takes effect at once. Before, installing a newer WordPress recipe was accepted but ignored until the Platform restarted, so Projects never offered the upgrade. The Platform picks the version from its allow-list, as it does for its own updates. After updating a recipe, its Projects offer **Upgrade** straight away. The same update is available as `POST /runtime/services/:name/update`, `client.marketplace.update(name)` and `zelavis marketplace update <name>`. `client.marketplace.services()` and `zelavis marketplace updates` list what can be updated.
