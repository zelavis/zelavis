---
"zelavis": patch
"@zelavis/ui": patch
---

Upgrading a Project to a recipe the Marketplace lists but this server has not installed now works from the dashboard: **Upgrade** installs the recipe first, then upgrades. This is the case of a WordPress site created while WordPress came with the Platform. Before, the upgrade ran from the listing, which carries no install instructions, and failed with "Integration updates cannot change the app's deployment contract". Through the API, SDK and CLI such an upgrade is now refused with a message saying to install the recipe first.
