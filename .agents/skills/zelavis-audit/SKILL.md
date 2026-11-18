---
name: zelavis-audit
description: Perform read-only, evidence-based code audits of plan implementations, features, changes, repositories, or specific paths. Also compare independent audit reports, prepare fix handoffs, or verify fixes against prior findings.
---

# Zelavis Audit

Use the user's requested scope and mode. Run each stage only when requested. The workflow is model-independent and works with plans from any source.

## Read-only boundary

Write only audit report files in the designated output directory. Do not patch or commit code, install dependencies, change configuration, publish comments, or start a fix task. Use inspection, static analysis, and existing tests only when their effects are understood. If a check could write files, generate artifacts, change a database, or affect an external system, obtain explicit permission for that check or skip it and record the gap. Permission to validate a finding does not authorize fixes.

## Audit workflow

1. Establish the target, revision or working-tree state, and intended behavior. For a plan audit, locate the plan (for example under `.agents/plans/`, or wherever the repository's instructions keep plans) and read the linked steps, subplans, and acceptance criteria. Treat progress markers and implementation summaries as leads and verify against source.
2. Find the repository's own rules before judging anything: agent instruction files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md`, and nested ones in the directories audited), the references and skills they link, `SECURITY.md`, `CONTRIBUTING.md`, and architecture or decision records for the area. Open the links rather than assuming what they say. Their security, authority, data-integrity, architecture and forbidden-pattern rules are audit requirements alongside the language's general practice; where they are stricter, they win. Note the project's own verification gates and which of them are safe to run under the read-only boundary.
3. Map entry points, callers, dependencies, trust boundaries, and persistent state. For a change audit, identify the base and head and follow affected paths beyond the diff. For a repository audit, inventory the subsystems and cross-cutting boundaries, then track coverage for each before claiming completion.
4. Trace normal, invalid, concurrent, and failure paths through callers and integrations. Check authentication, authorization, untrusted input, serialization and secrets, edge cases, transaction and data integrity, async lifecycle and cleanup, and concrete performance or scalability bottlenecks. Check every repository rule found in step 2 that applies to the audited code, plus architecture, implementation completeness, and regression coverage where they affect the requested behavior.
5. Verify triggers and consequences against code, configuration, and existing tests. For plan audits, account for every requirement, including integration, error handling, and fallback behavior. Investigate data flow and reachability before calling an unsafe API a vulnerability. Report concrete triggering conditions where possible, keeping security validation within permitted defensive analysis. Prefer actionable root causes over cosmetic observations or speculative refactors.
6. Write the Markdown report using [the reporting guide](references/reporting.md). State evidence, verification status, and coverage limits. If there are no actionable findings, say so and describe what was checked.

For an independent audit, exclude existing audit reports from initial discovery and build findings from the implementation. Inspect other reports only in a separately requested comparison or verification. For comparison, fix handoff, or verification, follow [the reporting guide](references/reporting.md).
