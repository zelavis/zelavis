---
name: zelavis-repo-maintainer
description: Use when maintaining the Zelavis repository itself, including GitHub workflows, Dependabot, community files, issue templates, labels, release hygiene, and contributor-facing repo process.
---

# Zelavis Repo Maintainer

Use this skill for changes in:

- `.github/*`
- root docs such as `README.md`, `CONTRIBUTING.md`, `SECURITY.md`
- release and dependency workflow files
- contributor and maintainer process

## Working rules

- Keep contributor-facing docs concrete and current.
- The JS/TS SDK ships with `zelavis` from `packages/zelavis/src/sdk`. Draft cross-language generator recipes belong in `scripts/sdk-codegen`; do not describe them as published SDKs or check in generated output. Keep security reporting and community policy discoverable; remove obsolete planning notes rather than adding speculative root documentation.
- Keep `CONTRIBUTING.md` a concise onboarding guide linking to canonical rules in `AGENTS.md` and focused `.agents/` guidance. Reviewer ownership belongs in `.github/CODEOWNERS`; do not duplicate it or workflow rules in a root `MAINTAINERS.md`.
- Prefer simple automation with clear ownership over clever repo machinery.
- Do not claim GitHub settings are enabled unless they were verified.
- Separate repo-policy changes from product code changes when possible.
- Treat `AGENTS.md` as the canonical coding-agent instruction file. `.github/copilot-instructions.md` only points to it; keep it that way rather than restating rules there.
- There is no `CLAUDE.md`; do not add one. Durable project guidance belongs in `AGENTS.md`.
- Keep `.agents/` synchronized with `AGENTS.md`. When repo guidance affects a specific workflow, update the relevant skill or add a focused reference file.
- Claude Code reads `AGENTS.md` directly but loads a skill only once it is linked into `~/.claude/skills/` (AGENTS.md § Agent Instruction Source Of Truth). Keep nothing tracked in `.claude/`: no skills, references, hooks or symlinks. A new skill in `.agents/skills/` needs that link on each maintainer's machine.
- `pnotes/TODO.md` is being retired and may only shrink: delete done items, never add any. Open work goes into `.agents/plans/` (AGENTS.md § Repo Structure).
- Repository and process code follows [TigerStyle for TypeScript and Effect v4](../../references/tigerstyle-typescript.md) like any other code; `pnpm check:tigerstyle` and `pnpm test:repo-rules` run in `pnpm verify`.
- Follow the GitHub Zero-Spend Policy in `AGENTS.md` and [its operations guide](../../references/github-zero-spend.md): public standard Ubuntu CI only, no hosted macOS/ARM build matrices, paid runners, artifact uploads, release archives, or Actions caches without an explicit owner request changing the policy. Omit `cache` and set `package-manager-cache: false` on every `actions/setup-node` step. Use the Mac or disposable VPS environments for additional qualification; never run untrusted public PR code on the everyday Mac or production VPS.
- Verify live $0 budgets and Stop usage settings before reporting them as configured. Do not add payment methods or paid capacity.
- Upstream source references stay local under Git-ignored `/repos/`. Use `pnpm refs:sync` to derive the exact Effect version and maintain `scripts/reference-sources.json` with dependency upgrades. No `postinstall` or CI downloads; missing local references are allowed in verification, but present references must match and be clean. Keep [Effect guidance](../../references/effect-v4-guidance.md) aligned.

- `pnpm dev` checks the shared GitHub variable `ZELAVIS_ACTIONS_STORAGE_LAST_CLEANUP` on startup and hourly; verified cleanup is due every seven days. Use Effect-scoped maintenance and each maintainer's own `gh` auth (Write role; Actions write and Variables write for fine-grained tokens). Preserve SARIF reports and unknown/recent items, tolerate concurrent deletion, and keep failures independent of development. No local timestamp files, timers, billing changes, CI cleanup jobs or `refs:sync` side effects. See the zero-spend operations guide for the exact deletion policy and opt-out.

## Repo checklist

1. Update docs and templates together so they do not drift.
2. Keep issue labels and templates aligned.
3. Document any manual GitHub UI steps that cannot be done from code or CLI.
4. Leave unrelated local-only folders and machine state alone.
5. Check whether changes to `AGENTS.md` should also update `.agents/skills/*/SKILL.md` or `.agents/references/*`.

## Validation

Use the relevant checks for repo-health changes:

```bash
git diff --check
pnpm run verify          # also what CI's ci:runtime runs
pnpm run docs:check
pnpm audit:security
pnpm run ci:ui           # when a change reaches the dashboard
```

For GitHub storage upkeep, `pnpm github:storage:check` is read-only and `pnpm github:storage:clean` deletes only what the policy allows.
