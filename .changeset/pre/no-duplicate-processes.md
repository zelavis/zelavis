---
"zelavis": patch
---

A Project never runs two copies of the same process. Before a recipe process starts, any uncontrolled process of that Project running the exact same command (left behind when an engine was lost mid-start, or a failed update) is stopped first.
