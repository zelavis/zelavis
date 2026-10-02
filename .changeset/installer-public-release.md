---
"create-zelavis": patch
---

Share one authored bootstrap with the public machine installer. It fetches the private Node pinned by the release from nodejs.org and the exact `zelavis` version from npm, and forwards installation flags to the common host-local installer.
