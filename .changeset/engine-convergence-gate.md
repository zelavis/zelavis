---
"zelavis": patch
---

A Platform update no longer moves a managed app's bound App to an engine that writes a different data layout. Engine
releases now declare the data format they write (`runtime-artifact.json` `metadata.dataFormat`; a release that declares
none is read as format 2, which every release up to alpha.42 wrote). A running bound App follows the Platform's engine
only when both formats are equal; otherwise it stays on the engine that wrote its data, says why in its logs, and waits
for its own recipe upgrade.

The same rule applies when a bound App's host starts cold (after a reboot or crash): it starts on the engine its host last
selected rather than being reset to the Platform's.
