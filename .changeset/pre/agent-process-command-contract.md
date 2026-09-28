---
"zelavis": minor
---

Run local Project processes through the Agent command contract.

Three drivers each supervised their own children: the Node Project runtime, the
server frontend runtime, and native WordPress. Each had its own `spawn`, its own
line splitting, its own SIGTERM-then-SIGKILL escalation, and its own answer to
what happens to a child when the Platform exits — two of them had no answer at
all, so a Platform crash left their processes running.

They now issue commands through `ZelavisAgentProcessRunner`. The Agent's
existing host operation contract describes a short, registered, digest-pinned
program; a Project runtime is the other shape — it announces readiness on its
own stdout, serves for as long as the Platform wants it, and has to be given a
chance to finish when stopped. The new contract covers that shape: line output,
escalation, a stop that resolves only once the process is actually gone, and an
exit that reports whether the Platform asked for it.

Doing this before a remote Agent exists is the point: the local runner is the
first implementation of one contract rather than the thing a remote Agent would
have to be retrofitted around. Each driver takes an `agent` option and defaults
to the local runner, so nothing about single-host behaviour changes.

Native WordPress no longer hands the Platform's entire environment — bootstrap
token, provider credentials, signing keys — to nginx, php-fpm, its database, or
the one-shot setup commands beside them. Host package installation (`brew`,
`apt`, `sudo`) opts back in explicitly, because those are configured through
environment variables an operator sets and they run as the operator
provisioning their own machine rather than as anything a Project influences.
