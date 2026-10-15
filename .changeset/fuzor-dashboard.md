---
"zelavis": patch
"@zelavis/ui": minor
---

The dashboard is now built with Fuzor. It is the same dashboard to use: every page is there, the Database workspace is rebuilt natively with three grid libraries and draft recovery, and the pages not yet rebuilt run unchanged inside it. One build now mounts at any root path (`/zelavis`, `/admin`, `/`), the dashboard calls the Platform it runs in directly rather than over a guessed address, and the package ships only built output that needs nothing installed beside it. The previous React dashboard stays in the repository as `@zelavis/ui-legacy`, private and no longer shipped. Development uses the Fuzor checkout next to the repository when there is one, and the pinned npm release otherwise.
