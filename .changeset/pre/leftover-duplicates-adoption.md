---
"zelavis": patch
---

A Platform update no longer fails because a Project has leftover duplicate processes. When adopting a Project's running processes, identical extra copies of a process the plan already adopted (left by a replacement an earlier failed update never stopped) are stopped instead of making the whole adoption fail, and a genuine mismatch now names the process and the field that differs.
