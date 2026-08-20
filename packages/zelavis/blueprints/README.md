# Zelavis Blueprints

This directory is the shipped blueprint catalog for the Zelavis Platform OS.
The published `zelavis` package includes it so a fresh self-hosted installation
can create projects without contacting an external marketplace.

`zelavis-app/latest` describes the current first-party Zelavis App project
stack. Downloaded versions and third-party blueprints belong in the runtime
cache at `.zelavis/blueprints`; created projects record the exact blueprint id
and version in their project lock data.

A Blueprint is not a runtime service and does not register dashboard menus.
Its manifest selects versioned services. After provisioning, those services
expose APIs and contribute fixed or dynamic menu metadata through the standard
Zelavis service contract. This keeps the same menu system for Zelavis App, optional
plugins, and future Blueprint service sets.

The default Node runtime installs project state under
`.zelavis/projects/<project-id>`, writes `blueprint.lock.json`, and starts the
Zelavis App runtime in an independent Node process. That boundary separates project
data and failures, but it is intended for trusted code and is not a security
sandbox. The project process is headless: it does not mount `@zelavis/ui` or
serve a private dashboard. The Platform OS owns the one dashboard and reads the
project's service metadata through its runtime proxy.
