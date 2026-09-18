---
"zelavis": patch
---

Stop a completed host operation from crashing its host process when the kernel
recycles the leader's pid.

The Node host-operation executor kills the operation's process group both at the
deadline and when its leader exits, so that descendants cannot outlive the
operation or hold its output pipes open. By the time the `exit` handler runs the
leader has been reaped and its pid is free, and `signalGroup` swallowed only
`ESRCH` — the group being gone. A pid the kernel has already recycled into a
group the executor may not signal answers `EPERM` instead, which is the same
benign race, and that error was rethrown from inside an EventEmitter callback.
Any operation that finished normally could therefore take the host process down,
and the odds rise with the pid churn of a loaded host.

`EPERM` is now treated exactly as `ESRCH` is. This was surfaced by an
adversarial test failing four of six full-suite runs while passing standalone;
a new test pins the behavior by refusing every process-group signal.
