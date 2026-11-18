# Audit reporting

Use the requested output directory. Otherwise use `audits/<audit-name>/` at the audited repository root. Reserve a distinct directory for each independent report and each follow-up, adding a model label or run suffix as appropriate. Check for collisions and preserve prior reports. If the chosen directory is not ignored by version control, say so in AUDIT.md and in the reply instead of editing ignore files.

- **AUDIT.md** records the executive summary, scope and revisions, methodology, findings overview, and verification status. Link the other report files.
- **FINDINGS.md** lists detailed findings in severity and practical-risk order. For large audits, split this file by subsystem or category and link each part from AUDIT.md.
- **COVERAGE.md** records the areas inspected, validation and results, gaps, and unexplored areas. For plan audits, map each applicable requirement to implementation evidence, status, and any finding IDs.

## Findings

Give each finding a stable ID such as `SEC-001`, `BUG-001`, or `PERF-001`, a specific title, severity (Critical, High, Medium, Low, or Informational), and confidence (Confirmed, High, Medium, or Low). Cite exact repository paths and line numbers at the audited revision. Record the root cause, preconditions, concrete trigger or permitted validation, impact, proposed resolution, and the applicable requirement, plan step, or repository rule (cited by file and section). Reuse IDs when revisiting the same finding and retain source IDs when consolidating reports.

Distinguish confirmed defects, strongly supported suspected defects, risks requiring investigation, and optional improvements. Explain uncertainty and keep optional improvements out of defect counts. Group overlapping symptoms under the same root cause when they share a fix.

## Follow-up modes

- **Comparison.** Read only the selected reports and relevant source. Deduplicate by root cause and trigger, preserve distinct findings, and recheck disputes at the relevant revisions. Keep each finding's source report and original ID. Record unresolved disagreements and their missing evidence. Agreement between reviewers does not establish validity.
- **Fix handoff.** Turn selected findings into an ordered implementation brief. Include severity, practical risk, dependencies between fixes, testable acceptance criteria, suggested regression tests, and links to original evidence. Add `HANDOFF.md` to the new report directory and link it from `AUDIT.md`.
- **Verification.** Trace every selected finding against the fix and its current callers, review new tests and regressions, and record supporting evidence. Mark each original ID **Resolved**, **Partially Resolved**, **Unresolved**, or **Cannot Verify**. An implementation summary alone is insufficient. Give new defects their own IDs.
