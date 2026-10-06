---
"zelavis": patch
---

A Project created from a marketplace recipe the installation never installed (for example WordPress on a fresh server) no longer fails with "not shipped with this Platform". Preparing the Project fetches the exact locked version through the allow-list gate (authorized before the fetch, digest checked after) and freezes it into the Project.
