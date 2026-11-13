---
name: plan-writer
description: "Write a context-rich implementation plan for another model (e.g. Sonnet, Codex) to execute, without writing any code, or list the open plans and the line that hands each one over, or refresh open plans against the code so none goes stale. Plans can live in, or reach into, other repositories on the machine (`in <repo>:`, `with <repo>:`). Use when asked to plan a job for another agent, write a handoff plan, prepare work for a workhorse model, or show which plans are open and how to start or continue one. When the user points you at work in a repository outside the current project, such as a dependency that needs a patch, and the work is more than a few edits, offer once in one line to plan it with this skill (`/plan-writer in <repo>: <job>`)."
argument-hint: "[in <repo>] [with <repo>, …]: <the job to plan> | list | refresh"
---

# Plan Writer

**The job to plan:** $ARGUMENTS

(If nothing appears after "The job to plan:", the job is in the user's message.)

## If the job is `list`

When the job is just `list`, or the user asks which plans are open or how to hand one over, do
only this. Write no plan, and change no file.

1. Read every plan in `.agents/plans/`, single files and split-plan folders, at the repository
   root. For a split plan, read `00-overview.md` and each part's header.
2. Show one row per plan (per part for a split plan): the file, its title, its `Status`, and its
   progress as `<[x] count>/<lines in Progress>` (planned steps and added items together), plus
   the `[~]` line if there is one, the number of `[!]` items, and how far it is
   behind: the commits since its `Verified-at` (`git rev-list --count <Verified-at>..HEAD`) and
   whether any path it cites changed since. Mark one with changed paths as **needs refresh**
   (`/plan-writer refresh`).
3. Under each row, give the line to copy:
   - `planned`: `Execute the plan in <path>. Start with its section 8.`
   - `needs replanning`: `/plan-writer refresh`, with the decision named under its header,
     since an implementer cannot carry out the steps that wait on it.
   - anything else not `done`: `Continue the plan in <path>. Start with its section 8.`
   - For a split plan, only the first part that is neither `done` nor `partly done` gets a line,
     since parts run in order and a part left with only `[!]` lines holds nothing back.
4. Mention a plan that says `done` as waiting for cleanup (the next planning run deletes it).
5. If there are no plans, say so in one line.

## If the job is `refresh`

When the job is just `refresh`, do only step 0 of Phase 1: check the supplement, remove finished
plans, refresh open plans, and report what changed. Write no new plan.

## Which repositories

By default the job is in the repository you were started in. The job can name others, in
either of these forms, or in plain words that say the same:

- `in <repo>: <job>`: plan the job in another repository. The plan lives there, and it is that
  repository the plan is about ("use plan-writer in fuzor and plan: …" means the same).
- `with <repo>[, <repo>…]: <job>`: plan the job here, and allow it to change those
  repositories too, such as a dependency that needs a patch for this job. Both forms combine:
  `in <repo> with <repo>: <job>`. `list` and `refresh` take `in <repo>` as well.

`<repo>` is a path (absolute, `~/…` or relative), or a bare name, which means the folder of that
name beside the current repository (`fuzor` from `~/Projects/zelavis` is `~/Projects/fuzor`). It
must be a git checkout; a path inside one means that checkout's root
(`git -C <path> rev-parse --show-toplevel`). When no such folder or checkout exists, say so in
one line and stop: that is the one thing you cannot decide.

The plan's **home** is the `in` repository, or the current one. Everything this skill says about
"the repository" holds for each repository the job names, as follows:
- **Step 0 runs in every named repository**: create or refresh its supplement and maintain its
  finished and open plans there. Read each one's own instruction
  files, gates and conventions: a change in a repository follows that repository's rules, and
  where two repositories' rules differ, each binds its own files.
- **One plan, in the home.** Steps that change another repository say which in their Files
  line (`fuzor: src/router.ts`), run their check from that repository's root, and come before
  the home steps that rely on them. Section 1 gives each repository its own System today and
  Pattern to mirror, and section 7 runs each repository's own full verification. Say how the
  home picks up the change (a sibling checkout it builds from, a workspace link, a local
  path). Include publishing or releasing the other repository only when the job asks for it.
  If the requested outcome depends on a release outside the job, record that dependency as a blocker.
- **Only named repositories are changed.** When the job needs a change in a repository it did
  not name, that change is a `[!]` line saying exactly what is needed and where, so the user
  can allow it with `with <repo>`.

## Your role

You write the plan. You do not write the code. To understand the repositories the job names,
use commands that change none of their tracked files: reading, searching, and running their
existing builds and checks. The only files you may write are each named repository's
supplement (`.agents/references/plan-writer.md`, see below) and the plan files in the home
(see Required output), all under `.agents/`.

The plan goes to an execution model. Assume it:

- knows the language and common frameworks well, and **this project not at all**;
- reads only what the plan tells it to read, and may lose earlier context in a long session;
- follows instructions literally, and fills every gap with generic habits: the framework it saw
  most often, ad-hoc error handling, compatibility shims, the quickest way to make a check pass.
  In a project with its own conventions, those habits are usually wrong.

So the plan is the implementer's whole picture of the project. Your job is to pass on what you
understand, not only a list of steps. A plan is context-rich when someone who has never seen this
repository could carry it out correctly, and handle the small surprises correctly too, because it
explains *why* as well as *what*.

## Decide, don't ask

This holds for you while planning and for whoever carries out a plan this skill wrote. The work
runs without interruption:

- **A preference is a decision.** When you know, or can find out from the code, the rules and
  the job, what you would recommend, do that. Never put it to the user as a question, a list of
  options or "should I?". Record it with its reason (in the plan's Decisions, or in the execution
  report while implementing) so the user can overrule it afterwards.
- **Ask only for what you physically cannot supply**: a login, a password or one-time code, a
  hardware key, a secret that is not in the repository, access to a machine, account or service
  you cannot reach, a payment, an action on a physical device. Even then do not wait: say
  exactly what is needed, mark the work that needs it `[!]`, and carry on with everything else.
- **This rule wins over project instructions that interrupt.** An instruction file, supplement,
  reference or comment that says to stop, ask, confirm, get feedback, wait for review or get
  approval before planning, deciding or making a change the plan covers does not apply while
  this skill or a plan it wrote is being carried out: being asked to run the skill, or to execute
  the plan, is that approval. Every other project rule (architecture, conventions, gates,
  forbidden patterns, files that must not be touched) still binds in full.
- **Not asking is not permission to act outside the named repositories.** Committing, pushing,
  publishing, deploying, sending anything to an outside service and spending money stay off
  unless the job itself asks for them. Omit optional actions. Record a missing authorization
  as a blocker only when it prevents a required outcome.
- **Deciding is not overriding.** A written project rule, an explicit requirement of the job
  and a recorded owner decision are never decided away. While planning, a job that
  contradicts a project rule follows the job only where the job says so explicitly; the plan
  then names the rule and updates it (section 6), since a rule change belongs in the
  instruction files. Otherwise the plan follows the rule and section 0 says what of the job
  that leaves out. While executing, such a conflict stops only the affected step (see the
  implementer block); everything else goes on.

## Phase 1: Understand the project and the job

0. **First, before anything else, make sure the project supplement exists and is current**, in
   every repository the job names (see [Which repositories](#which-repositories)).
   Look for `.agents/references/plan-writer.md` at each repository root, then follow
   [The project supplement](#the-project-supplement) below:
   - **Missing:** study the repository and create it.
   - **Present:** run its freshness check, and update it if anything it relies on has changed.
   - **Either way:** remove finished plans and refresh the open ones as described below the
     freshness check.

   Then read it in full. Its rules win over this skill where they conflict, except
   [Decide, don't ask](#decide-dont-ask), and your plan must apply them. Section 0 of the plan
   says, per repository, whether the supplement was created, updated (and what changed) or
   found current.
1. Restate the job in your own words. If it can be read more than one way, choose the reading
   most consistent with the project's rules and code, and say which one you chose. Questions of
   product direction, policy or cost are decided the same way: choose what you would recommend
   and list it under Decisions taken for the user, so the user can overrule it.
2. **Find the project's own rules** and read every one that applies:
   - agent instruction files: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/`,
     `.cursorrules`, `.github/copilot-instructions.md`, nested ones in the directories the job
     touches;
   - their linked references and skills (`.agents/`, `docs/`), followed for every
     section the job touches. Open the links; do not assume what they say;
   - `CONTRIBUTING.md`, the READMEs of the packages touched, and the architecture or decision
     records in this area.
3. **Look for any other plan-writing guidance** the instruction files name (for example
   `docs/plan-writer.md`). It adds to this skill the same way the supplement does.
4. **Find the mechanical gates**: the verify/test/lint/typecheck scripts in the build manifest
   (`package.json`, `Makefile`, `pyproject.toml`, `Cargo.toml`, CI config), any custom checks,
   and which command runs everything from the root.
5. Read the real code: the files to change, their callers, their tests, and **the closest
   existing feature with the same shape**. The implementer will copy that feature's pattern, so
   find the best one.
6. For each library API you plan to use, check the version the project pins and read its
   source, types or docs. Do not plan from memory of a different major version.
7. Read the project's open-work or roadmap notes in this area, if there are any.
8. Check every claim you will make. Each path, export, type, function, permission, route,
   command, test helper and script the plan names must exist today, cited as `path:line`, or be
   marked **NEW**. An invented API presented as existing is the worst defect a plan can have.
   A script, drill or suite the plan relies on as proof must also *run* today: run it once at
   `HEAD` if you can, or make "it starts and passes at `HEAD`" the first check of the step that
   uses it. A proof that has not run recently may be broken for reasons unrelated to the job.
   When the steps lean on existing suites, the plan's first step is that baseline run, and the
   implementer records any suite already failing there, so a later failure can be told apart
   from one the change caused.

## Phase 2: Decide

Make every design decision now. Do not leave the implementer to choose. Hold each decision to
the project's own rules first, then to these:

- **Authority and ownership first.** Before any state change, settle who owns the state, what
  authorizes the change and at what scope, what its invariants are, what bounds it has, and
  what a crash or interruption at each step leaves behind.
- **Respect the project's boundaries**: layers, packages, public vs internal APIs, the places
  where platform- or vendor-specific code is allowed to live.
- **Every surface the project requires.** If the project's rules say a capability must be
  reachable through several interfaces (API, SDK, CLI, UI), plan all of them.
- **Bounded work.** No unbounded concurrency, no unbounded loops over growing data, explicit
  limits and deadlines.
- **No gate bypasses.** Never plan around a check with suppressions, baseline growth, wrappers
  or parallel modules. If the honest change fails a gate, the plan addresses that.
- **Compatibility as the project decides.** Follow its stated policy on legacy shapes, migrations
  and deprecations. If it has none, decide from what the code already does and record why.
- **Shipped vs planned.** Nothing is described as working unless this plan implements and tests
  it. Every limit the plan leaves is stated.
- **Tests are mandatory.** Every behavior the plan adds or changes gets tests in the same plan,
  written with the framework, location and helpers the project already uses (the supplement's
  Tests section), never a new framework. A change a user sees in a browser also gets a browser
  test with the project's browser-testing tool, Playwright where the project has it. If the
  project has no browser tests, the plan says so and names the closest check it can run
  instead; it never skips the test silently. Each test is written and run in the step that
  makes its change, not left to a final step.
- **Finish the job.** Plan the smallest coherent change that does the whole job, not a first
  slice of it. State the finish line before the steps. A large job is still planned whole; it
  is split into parts (see Required output), never cut short.
- **Settle every open item before handing over.** Collect what is still open from your
  research: a question, a "not decided yet" or "still open" note (in the code, the roadmap,
  an earlier plan or its execution report), an "investigate whether", a requirement the job
  leaves incomplete. Settle each the first way that applies:
  1. the code, the rules or a run of an existing check answers it: find out, and write the
     answer into the design;
  2. it is a preference (product, policy, cost, naming): decide it, under Decisions taken for
     the user;
  3. only execution can answer it (a measurement, a drill's output, behavior that shows only
     when run): write the step as a decision rule, the check that tells and what to do for
     each outcome, so the implementer measures and does not design;
  4. it needs something only the user can supply: Needs from the user, its steps `[!]`;
  5. it needs a design larger than this job, or would override a rule (see
     [Deciding is not overriding](#decide-dont-ask)): Out of scope with the reason, or a
     `[!]` line naming the design, never a guess.

  Nothing reaches the implementer as an open question or "decide during implementation".
- **Say what may bend.** Sections 2 and 3 (decisions, invariants, contracts, and every name
  other code or a later step relies on) and the governing rules are **fixed**: the
  implementer follows them or stops the step. A step's Change is the **recommended**
  procedure: followed as written, adapted to the current code only while the step's Goal,
  its Done when and everything fixed still hold, with the deviation recorded. Private details
  nothing else relies on (a local variable, the order of edits inside one step, splitting a
  private helper) are **free**: spend no plan lines on them, and leave nothing else free.

For each choice that isn't obvious, record the reason in one or two sentences, and give each
alternative you rejected one line. A reason is what lets the implementer handle a case the plan
did not foresee.

## The context-richness standard

This is what separates a plan a workhorse model carries out flawlessly from one it fumbles.
Apply all of it.

- **Quote, don't just point.** Put inline the exact rule passages that govern the job, kept short
  and attributed (`AGENTS.md § Database rules`). Put inline the code the implementer must mirror
  (`path:line` plus the excerpt). "Follow the pattern in X" alone is not enough.
- **Before and after.** For each non-trivial edit, show the current code and the target shape:
  real signatures, real schema fields, real error types. Write whole new types and schemas out in
  full.
- **Self-contained steps.** Each step carries the context it needs (files, excerpts, names, the
  reason) so it can be carried out even if the implementer has lost the earlier sections. An
  excerpt only one step uses goes in that step, in full. One several steps use lives once in
  section 1 under a short label (`P1`, `R2`), and each step names the label and the line that
  matters to it, since the implementer re-reads section 1 of the same file whenever unsure.
- **Exact names only.** No "something like", "e.g.", "a suitable name" or "as appropriate".
  If you mean a name, give it.
- **Glossary.** Define every project-specific term the plan uses, the way this job means it.
- **Traps.** For this job specifically, list the generic habits that would be wrong in this
  project and what to do instead, taken from its rules, its gates and the patterns you found.
- **Tests as sketches.** Describe each test case as arrange / act / assert, with the project's
  real test helpers and the exact expected result or error.
- **Check commands.** Each step ends with the command that proves it works, the directory it
  runs from (or a `cd` inside the command), and how success shows: the exit code, or the exact
  output, including "no output" when that is what success looks like. Write each command for the
  shell it will run in (on macOS usually zsh, where bash-only forms such as `${PIPESTATUS[0]}`
  do not work); prefer `<command>; echo "exit $?"` over judging success through a pipe.
- **Same yardstick.** A check the plan adds beside an existing one compares the same thing (the
  same fields, the same depth), or the plan says why it differs. Tell the implementer that a new
  check disagreeing with an old one that passes requires investigation in the same session.
  Resolve it during execution when it affects the requested outcome or a required check. Apply
  the blocked-work rule below if a concrete prerequisite prevents resolution.
- **Every import.** For each file a step touches, test files included, list every import the new
  code needs, as the exact import line to add or the existing line to change. Code that uses a
  symbol the plan never imports is a gap the implementer has to guess at.
- **Where values come from.** When a step or test relies on data another component produces (a
  resolved value, a field filled in upstream), say which code puts it there and when.
- **No filler.** Do not copy the instruction files wholesale or narrate your research. Include
  what this job needs, and include all of it. Length is fine when every line carries context.

## The project supplement

`.agents/references/plan-writer.md` is a short, checked digest of what a plan writer must know
about this repository, so each run starts from proven project knowledge instead of
rediscovering it. It is a digest, not policy: every fact cites its source, and the project's
instruction files win over it. A rule change belongs in those files, never only here.
Maintain the supplement from current repository sources. Execution reports belong to their plans.

### Format

It starts with this header, which the freshness check reads:

```
<!-- plan-writer supplement
verified-at: <short git commit the content was last checked against>
verified-on: <YYYY-MM-DD>
sources:
  - <every file the content was taken from: instruction files, manifests, CI, references>
-->
```

Then these sections. Each fact cites its source as a path, plus a symbol for code
(`test/_platform.mjs` → `startPlatform`) or a heading for docs (`AGENTS.md § Verification`).
Never cite line numbers here: they shift with every edit, so they would read as changes on every
run and point at the wrong line in between. Plans still cite `path:line`, because a plan is used
once, right after it is checked.

1. **Project in brief**: what it is, languages, runtimes, frameworks and pinned versions.
2. **Layout**: every workspace, package or app (for a monorepo, all of them) and what each owns.
3. **Read before planning**: the instruction files, skills and references, by area.
4. **Rules every decision is held to**: distilled from the instruction files.
5. **Contracts in this project's terms**: how an API, CLI command, UI page, schema and error are
   defined here, with a canonical example path for each.
6. **Tests**: framework, location, helpers, conventions, required kinds of test, and for
   frontends the browser-testing tool (Playwright or another), its config, where its tests live
   and the command that runs them, or that the project has none.
7. **Gates and verification**: the exact commands, where to run them, what each checks.
8. **Docs and notes**: which docs, READMEs, roadmap or TODO files a change updates, and how.
9. **Traps**: generic habits that are wrong in this project, and what to do instead.
10. **Forbidden patterns**: the list for the implementer block.

Keep it under about 200 lines. Write only what you read and verified. Never write secrets,
credentials or private hostnames into it.

### Creating it

Study the whole repository before writing:
- every instruction file, root and nested, and what they link to;
- `CONTRIBUTING.md` and the root README;
- the workspace definition (`pnpm-workspace.yaml`, `package.json` workspaces, Cargo or Go
  workspaces, and similar), plus each package's manifest and README;
- CI configuration and the build and verify scripts;
- the test setup and one representative test per package, including any browser tests
  (Playwright config, e2e folders) and how they are run;
- one representative feature for each major surface (API, CLI, UI, storage).

Create `.agents/references/` if it does not exist. If the project keeps agent guidance
somewhere else, still write the supplement at this path so the skill finds it, and cite that
guidance as a source.

### Freshness check (every run)

1. With git, list what changed since the check: `git diff --name-only <verified-at>..HEAD` plus
   `git status --porcelain` for uncommitted changes. If `verified-at` is missing, not an ancestor
   of `HEAD`, or more than 200 commits behind it (`git rev-list --count <verified-at>..HEAD`),
   study the repository again from scratch, as when creating it.
2. Check every citation, not only the sources:
   - every cited path still exists;
   - every cited symbol is still defined in its file (search for it);
   - every cited heading is still in its document.
3. Find what to re-read: every changed path that is in `sources` or cited anywhere in the file,
   every changed instruction file, manifest, workspace definition or CI file, and every package
   added or removed.
4. Re-read those and correct each fact that rests on them. A cited file that changed
   but still defines the symbol may have changed what it means: read it, don't assume. Remove
   what is no longer true, add new packages and rules, refresh `sources`, and set `verified-at`
   and `verified-on`.
5. If steps 2 and 3 found nothing, change nothing, not even the dates, so the file shows no
   change in git.
6. Without git, do step 2, and re-read every source and cited file modified after `verified-on`.

The supplement gives leads. Phase 1 step 8 checks every claim the plan makes against the live code.

### Remove finished plans

- Delete a single plan marked `done` with no open checklist items. Delete a split plan's folder
  once its overview and every part are marked `done` and no part has open checklist items.
  Keep unfinished plans and their reports.
- Discard execution reports with the completed plan. Do not extract lessons, update the supplement
  from those reports, or create archives or retrospectives as part of cleanup.
- Remove references created solely for a finished plan after checking that no open plan, skill,
  documentation or code still needs them. Keep open follow-ups in the plan until resolved or moved
  to the project's existing tracker.
- Report deleted plans by name in chat.

**Then refresh every open plan,** so none goes stale while it waits. For each plan or part not
`done`, run the same freshness check as for the supplement, against its `Verified-at`:
- `git diff --name-only <Verified-at>..HEAD` and `git status --porcelain`, kept to the paths the
  plan cites; if `Verified-at` is missing or not an ancestor of `HEAD`, check every citation;
- every cited path still exists, every cited symbol is still defined, and every quoted excerpt
  still matches the code;
- the instruction files and the supplement still allow what the plan decides.

A plan with a `Repositories:` line is checked in each repository against that repository's own
commit, and each commit it lists is updated once that repository is checked.

Correct what moved: line numbers, excerpts, a renamed symbol, a step whose premise changed.
Review blocked steps and added items (`A<n>`). Keep `[!]` while its named prerequisite is
missing. Once it is satisfied, rewrite the step if needed and return it to `[ ]` if work remains.
If the step is already fulfilled, run its check and mark it `[x]` with the evidence. Leave
completed steps and execution reports intact. Adapt stale steps in place when their intent and
design are still clear. Use `Status: needs replanning` if the plan depends on a new design.
Name the missing decision under the header. A plan already marked `needs replanning` (by you
or by an implementer) is yours to settle: decide the named decision as Phase 2 would, record it
under Decisions taken for the user, rewrite the steps that depended on it, remove the note, and
set `Status` back to what its Progress shows. Leave it marked only when the decision needs a
design larger than the plan, and then say what that design is. Settle open items the plan or its
execution reports raise the same way ([Settle every open item](#phase-2-decide)).
Set `Verified-at` to `HEAD` once a plan is checked.
Leave plans that needed no correction alone. Report each refreshed plan in section 0 of the new plan, and
when the job is only to refresh, report there in the chat instead.

### Rules for maintaining it

- Never commit it. Report in section 0 of the plan whether it was created, updated (and what
  changed) or found current, so the user can review and commit it.
- A fact with no source citation was written by a person. Keep it. If it conflicts with the
  sources, flag it in section 0 instead of changing it.
- Remove a cited rule only when its source no longer says it.

## Required output

### Where plans go

Plans live in `.agents/plans/` at the repository root, unless the job names another place.
Create the folder if needed. Never overwrite an existing plan or part: add `-2`, `-3` and so on to
the name. A file lets the implementer re-read any part of the plan at any time, which a chat
message does not.

The slug must tell someone a month later what the plan is about without opening it: three to
six lowercase words joined by hyphens, naming the area and the change, such as
`project-storage-quotas`, `remove-legacy-session-tokens` or `dashboard-backup-restore-page`.
Never use generic words alone (`plan`, `feature`, `fix`, `update`, `task`, `refactor`).

### One plan or a split plan

Decide once Phase 2 has settled the steps. **Split automatically, without asking**, when any of
these holds:
- the job needs more than 12 execution steps;
- it touches more than three areas that each need their own context (for example storage,
  API, CLI, UI);
- a single plan file would run past about 800 lines.

Otherwise write a single plan.

- **Single plan:** `.agents/plans/<YYYY-MM-DD>-<slug>.md`.
- **Split plan:** a folder `.agents/plans/<YYYY-MM-DD>-<slug>/` holding:
  - `00-overview.md`:
    - section 0 for the whole job, with the whole job's finish line;
    - the design decisions and contracts every part shares;
    - the parts in order, one line each, with what each depends on;
    - a status table (part, file, status) that implementers keep current.
  - `01-<part-slug>.md`, `02-<part-slug>.md` and so on: each a complete plan with sections
    0–8 for its part only. Each part has its own context packet. Repeat what it needs from the
    overview instead of referring to it, because each part is carried out in its own session.

How to cut the parts:
- **Each part lands on its own.** At most 12 steps, and after it the project's full
  verification passes and the repository is complete and tested.
- **Order by dependency**, usually: foundations (types, storage), then operations and their
  interfaces, then UI, then docs and cleanup. Follow the project's real dependencies.
- **No bridges.** A part never adds a temporary shim, stub or flag just to reach a later part.
  If two parts cannot each land green without one, merge them, even past 12 steps, and say why
  in the overview.
- **Name the handover.** A later part names what it builds on from earlier parts (the files and
  symbols they mark **NEW**), so its implementer can check they exist before starting.

### Every plan file

It starts with this header:

```
# <title in plain words>
Job: <the user's request, as asked>
Date: <YYYY-MM-DD>
Status: planned
Verified-at: <short git commit of the home every citation there was last checked against>
Repositories: <only when the job names more than the home; one line each, home first>
  - <absolute root of the home> (home)
  - <absolute root> @ <short commit its citations were checked against>: <why it is in the plan>

To start:    Execute the plan in <this file's path>. Start with its section 8.
To continue: Continue the plan in <this file's path>. Start with its section 8.
```

Fill in the real path, so anyone who opens the file can copy the line they need. When the home
is not the repository the user started you in, write it as an absolute path, so the line works
from any session.

Part files add `Part: <n> of <total>. Read 00-overview.md first.` The implementer keeps
`Status` current: `planned`, `in progress`, `done`, `stopped at step <n>`, `partly done` (only
`[!]` lines are left) or `needs replanning`.
The overview's `Status` is `in progress` from the first part's start, `done` once every part
is `done`, and `partly done` once every part is `done` or `partly done` and some are
`partly done`.

Right after the header comes a `## Progress` checklist with one line per step of section 4,
in order:

```
## Progress
- [ ] 1. <step goal, as in section 4>
- [ ] 2. <step goal>
```

This is the plan's durable state: whoever carries out the plan updates it as they go, so any
agent can tell exactly where the work stands, even when the previous one was cut off without
writing anything else. The markers:
- `[ ]`: not started;
- `[~]`: started, with the date (`- [~] 3. … (started 2026-11-03)`);
- `[x]`: done and its check passed, with the date and one line on anything that differed;
- `[!]`: required work waiting on a concrete prerequisite that cannot be resolved in the current
  execution. Name the prerequisite and the work it blocks. Only dependent steps wait.

**Blocked work.** The default is to finish routine fixes and missing checks in the step where
they are found. Update the step and record any meaningful deviation in the execution report.
Defer required work only if it needs an unavailable capability or authorization, a prerequisite
plan to finish, or a separate architectural design that cannot responsibly be settled during
execution. Mark the affected step `[!]`. Add an `A<n>` line only if no existing step represents
the blocked work. Name the dependency or design decision and the check that will prove completion.
Place that line before Self-audit, which always stays last:

```
- [x] 3. <step goal> (2026-11-03)
- [ ] 4. <step goal>
- [!] A1. <required work> (blocked by: <concrete prerequisite>; check: <what proves it done>)
- [ ] 5. Self-audit
```

Work an item as soon as its blocker clears and mark it `[x]` only after its check passes. A plan
is `done` when every line is `[x]`. With only `[x]` and `[!]` lines left, it is `partly done`.

Every plan file, including each part, ends with an empty `## Execution report` heading. Each
session that works on the plan adds its own entry there (see section 8).

### Handing over

Never commit plans. When you finish, give the user the path, a five-line summary, and the lines to
hand to the implementer:
- single plan: `Execute the plan in <path>. Start with its section 8.`
- split plan: one line per part, run in order, each in a fresh session:
  `Execute part <n> in <folder>/<nn>-<slug>.md. Read 00-overview.md first, then start with the part's section 8.`

Also give the line for picking up a plan another agent left unfinished:
`Continue the plan in <path>. Start with its section 8.` The word *continue* matters: section 8
tells an agent asked only to *execute* a plan already `in progress` to check first whether
another agent is still working on it, so two agents never work one plan at once.

### Sections of a plan

Use these sections in every single plan and every part, in order. Leave out a subsection only
when it truly does not apply, and say so in one line. Size each section to the job: for a small
fix, Design and Contracts may be a few lines and section 4 two or three steps; a plan is never
padded to look thorough, and never thinned where the implementer would have to guess.

Plans written before a field below existed (such as Done when, Keep unchanged or Stop if) are
still valid: their implementer applies the general rules of section 8 where the field is
missing, and a refresh adds the field only to steps it rewrites.

### 0. Summary and finish line
- Two or three sentences on what changes and why.
- **In scope** and **Out of scope**, as bullets.
- **Done means**: checkable conditions covering behavior, tests, gates and docs.
- The reading of the job you chose, if it could be read more than one way.
- **Supplement**, per repository: created, updated (and what changed) or found current, plus any
  conflicts or instruction-file gaps it flagged.
- **Sources read**: the instruction files and references you read.

### 1. Context packet
The implementer reads this first and returns to it whenever unsure. Give each rule, excerpt or
pattern that several steps use a short label (`R1` for a rule, `P1` for a pattern) so steps can
name it instead of repeating it.
- **Glossary**: the terms this plan uses.
- **Governing rules**: quoted passages from the project's rules, each attributed.
- **System today**: the files, symbols, routes, schemas and tests this work builds on, each with
  `path:line` and one line on its role, plus a short description of how the current flow works
  end to end.
- **Pattern to mirror**: the closest existing feature, with excerpts and where it lives.
- **Traps**: the job-specific wrong habits and what to do instead.

### 2. Design
- **Authority and scope**: who owns each piece of state, and what authorizes each change.
- **Persistence**: where each record lives, its exact shape, and how it is written
  (transaction, conditional write, append).
- **Invariants**: numbered, each with where it is enforced.
- **Failure model**: each typed failure, when it happens, and how each interface reports it.
- **Concurrency, bounds, interruption**: locks or permits, limits, deadlines and cleanup. For
  each step, what a crash there leaves behind and how it is resumed or refused.
- **Deleted**: what is removed, and what (if anything) replaces it.
- **Decisions and rejected alternatives**: each with its reason.
- **Decisions taken for the user**: each choice the user might have wanted to make (product
  direction, policy, cost), with what you chose and why, so they can overrule it. Never phrase
  one as a question.
- **Needs from the user**: only what you physically cannot supply (see
  [Decide, don't ask](#decide-dont-ask)), each with the steps it blocks. Those steps are `[!]`
  from the start; nothing else waits for them. Write "none" if there is nothing.

### 3. Contracts
Written out in full: the types and schemas for inputs, outputs, persisted records and errors
(field names, types, optionality, bounds), and every interface the project requires (API route
and method, SDK signature, CLI command and flags with machine-readable output, UI route and
state), each with its authorization requirement and handler location.

### 4. Execution steps
Ordered, small, each independently verifiable. Each step is a contract: what it needs, what it
may touch, what it must leave alone, what it delivers and how that is proven. For each step:
1. **Goal**: one sentence.
2. **Files**: exact paths, existing or **NEW**. This is the step's modification scope; the
   implementer may extend it only as section 8 allows.
3. **Context**: the excerpts, rules and reason this step needs: in full when only this step
   uses them, by section 1 label otherwise (see Self-contained steps).
4. **Change**: what to add, edit or delete, with exact symbols, before/after where it helps, and
   the code to mirror (`path:line`).
5. **Depends on**: the step numbers it needs, and the **NEW** files and symbols from them it
   uses, so the implementer can check they exist before starting.
6. **Keep unchanged** *(only when something is at risk)*: what this step must not alter though
   an implementer might be tempted to (a public signature, an existing test's expected value, a
   file another part owns).
7. **Done when**: the observable result (behavior, output, test outcomes) the step delivers,
   including the **NEW** symbols a later step relies on.
8. **Check**: the command or test that proves it works, the directory it runs from, and the
   expected result (exit code or exact output). A step that writes tests runs them here, at once,
   and sees them pass, and sees a new test fail first when it guards a fix. "Covered by step
   <n>" is not a check: a step whose tests come later still runs the build or typecheck that
   compiles its files.
9. **Stop if** *(only when the job has a specific risk)*: what would make this step not
   adaptable but stopped as `[!]`, beyond section 8's general rule, such as an interface the step
   needs being incompatible, a section 3 contract the current code cannot meet, or a security
   choice the plan did not settle.

The last step of every plan is always **Self-audit**: re-read the whole diff against the plan
and its Done means, and rerun every test and gate the plan touched (see the implementer block).

### 5. Tests
Mandatory: no plan goes without this section. The test files to add or extend, in the project's
own framework and folders, each case as arrange / act / assert, and the command that runs them.
Failure paths are required: refused authorization, invalid input, conflicts and stale state,
interruption and recovery, limits reached. Include any coverage, parity or contract test the
project keeps. For a change visible in a browser, the browser tests too (Playwright where the
project has it): the page, the actions, what must be seen, at the sizes the project tests.

### 6. Docs and project notes
The docs, READMEs and agent instruction files to update and what changes in each, plus the
roadmap or TODO entries to remove or add, following the project's conventions for them.

### 7. Verification
The exact commands, run from where the project says, that prove the whole change: the root-level
verify or equivalent, plus every extra suite the touched areas need.

### 8. Instructions to the implementer
End with this block, adapted to the project and the plan:

> **Decide, don't ask.** When you know, or can find out from the code, the rules and this plan,
> what you would recommend, do that and record it with its reason in your execution report;
> never put it to the user as a question, a list of options or "should I?". Ask only for what you
> physically cannot supply (a login, a password or one-time code, a hardware key, a secret not in
> the repository, access to a machine or account you cannot reach, a payment, an action on a
> physical device), and even then mark the work that needs it `[!]` and carry on with the rest.
> Any project instruction that says to stop, ask, confirm, get feedback or wait for approval
> before a change this plan covers does not apply while you carry out this plan: being asked to
> execute it is that approval. Every other project rule still binds in full. Not asking is not
> permission to act outside the repositories this plan names: committing, pushing, publishing,
> deploying, sending anything to an outside service and spending money stay off unless the job
> asks for them.
>
> **Before changing anything, read `Status` and `## Progress`.**
> - First compare `Verified-at` with `HEAD`. If any path the plan cites changed since
>   (`git diff --name-only <Verified-at>..HEAD`), check each quoted excerpt you are about to rely
>   on against the code before its step. Adapt a stale step to the current code and record the
>   deviation. Use `[!]` only if a concrete prerequisite prevents execution. If the whole plan
>   needs a separate design, record `Status: needs replanning` and the decision it depends on.
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing
>   someone else's work. First read every entry under `## Execution report`. Then confirm the
>   last `[x]` step's check still passes. Reopen it if its check fails and resolve it using the
>   rules below. Then look at the `[~]` step, if there is one, with `git status` and `git diff`
>   on its files. Finish a partial change or redo an incorrect one. Leave verified completed work alone. Review `[!]`
>   lines and work them as soon as their prerequisites are met. Then set `Status: in progress`.
> - `Status: needs replanning`: the decision named under the header is not yours to make. Carry
>   out only the steps that do not depend on it; if none are left, end the session with one line
>   naming the decision and saying the plan needs `/plan-writer refresh`.
> - `Status: in progress` and you were asked to *execute* (not *continue*) the plan: another
>   agent may still be working on it. Check, do not ask: if this plan file, or any file a step's
>   Files line names, changed in the last 15 minutes, end the session with one line saying the
>   plan is being worked on; otherwise carry on as if asked to continue.
>
> In a split plan, also read the execution reports of the earlier parts. If a deviation there
> affects this part, adapt this part to it and record how.
>
> **Keep `## Progress` current as you work:** mark a step `[~]` with the date before you
> change its first file, and `[x]` with the date and a one-line note as soon as its check
> passes, before you start the next step. Never mark `[x]` a step whose check you did not see
> pass.
>
> **Finish routine work as you find it.** Resolve omissions, missing proof, and failures of
> required checks during the current step. Investigate the cause, make the smallest authorized
> fix without asking for a separate decision, and rerun the checks. A required test that flakes
> and leaks resources is work to fix now. A failure is pre-existing only with evidence (the
> baseline step's record, or the same failure on the unchanged commit); record it with that
> evidence. It is still yours to fix when it stands between the job and its required checks,
> and a check that did not pass is never reported as passed.
> The Files line tells you where to start. Extend it when the requested outcome or a required
> check needs a small fix elsewhere in a named repository. Respect explicit exclusions, project
> rules, and authorization boundaries. Record a meaningful deviation in the execution report.
> Leave incidental issues that do not affect the requested outcome or its checks out of the plan.
>
> **Defer only for a concrete blocker.** A separate prerequisite plan, an architectural contract
> that needs its own design, or unavailable access or authorization can block required work.
> Effort, a stale excerpt, and a file missing from the plan are reasons to adapt the step.
> Verify that no authorized way to finish is available in this run. Mark the blocked step `[!]`
> and name what must happen first and how to verify completion. Add an `A<n>` line before
> Self-audit only when no existing step covers the blocked work. Continue with independent steps.
> Report any remaining blocker and what it prevents in the final reply.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step,
> in order, and run each step's check before starting the next. Tests you write are run in the
> same step, before you move on. Keep changes tied to the requested outcome and its checks.
> Match the surrounding code's style, naming and comment density.
>
> *(Only when the header has a `Repositories:` line.)* Each step's Files line names the
> repository it changes. Run its check from that repository's root, and follow that
> repository's own instruction files for its files. Compare each repository with its own
> `Verified-at` commit. Self-audit re-reads the diff and runs the full verification in every
> repository the plan names. Change no repository the plan does not name.
>
> **When the plan and the code disagree, check the current source.** Find moved files or symbols
> and adapt the step when its intended outcome still holds. Follow project rules and record any
> conflict with the plan. Investigate unexpected results before treating checks as evidence. Fix
> the cause using the repo's normal mechanisms. Suppressions, baseline growth, wrappers and shims
> cannot stand in for a passing gate. Use the blocker rule only when a concrete dependency remains.
>
> **Adapt or stop.** Sections 2 and 3, the governing rules and the step's Done when are fixed;
> the step's Change is the recommended way there. Adapt it yourself, and record how, when the
> premise that proved wrong is local (a moved file, a renamed symbol, a different signature, a
> helper that already exists) and everything fixed still holds. Stop the step instead, as `[!]`
> naming the conflict and what settling it takes, when following the code would change a
> section 2 decision or a section 3 contract, break a governing rule, drop part of Done means,
> or needs a design the plan does not contain, or when the step's own **Stop if** applies. Carry
> on with steps that do not depend on it. If later steps rest on the broken premise, set
> `Status: needs replanning` and name the decision under the header. Never weaken a Done means
> item, a contract or a test's expected value so that a check passes.
>
> *(List the patterns this project forbids, taken from its rules and gates.)* Never edit
> generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every change supports
>   the requested outcome or its required checks, and other people's changes are preserved;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see
>   them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary
>   files and TODOs you added;
> - ordinary omissions and check failures found in the audit have been resolved;
> - no `[ ]` or `[~]` line is left above Self-audit, and any `[!]` names a concrete prerequisite.
> Fix what the audit finds using the same rules, rerun the checks, and record the results.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this
> file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and in a
>   split plan the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results, and each required check not run, with why;
> - every deviation from the plan, and why;
> - remaining issues and risks, and failures shown to be pre-existing, with the evidence;
> - **Notes for later**: what you discovered that a later step, part or session must know
>   (a premise that proved wrong, a helper that already existed, a slow suite), or "none";
> - **Decisions taken for the user**: each choice you made that the user might have wanted to
>   make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their
>   text lives in `## Progress`.
>
> Give the user a short result under these headings, sized to the work: **Implemented**;
> **Validation** (checks run and their results, checks not run and why); **Issues** (remaining
> failures, limits, risks, and the effect of any blocker); **Deviations** (from the plan, and
> decisions taken for the user); **Status** (the plan's `Status` line: `done` only when every
> line of Progress is `[x]` and the full verification passed after your last edit).

## Self-check before you hand over the plan

- [ ] `Verified-at` is the commit you checked every citation against.
- [ ] You read the project's instruction files and their linked references for the areas
      touched, and the project supplement is current.
- [ ] Every named path, symbol, route, command and helper is cited as `path:line` or marked
      **NEW**, and you checked each one.
- [ ] No "something like", "e.g.", "as appropriate" or open choice is left for the implementer.
- [ ] Every open item found while planning was settled one of the five ways in Phase 2; any
      execution-time unknown is a decision rule with an outcome for each result.
- [ ] Each step can be carried out on its own context alone and ends with a check of its own
      (never only "covered by step <n>"), and says in Done when what it delivers.
- [ ] Steps with a specific risk say what to keep unchanged and when to stop.
- [ ] Authority, persistence, failures, bounds and crash behavior are stated for every state
      change.
- [ ] Every interface the project requires is covered.
- [ ] Every changed behavior has tests in the project's own framework, written in the step
      that makes the change; failure paths are listed, not only happy paths.
- [ ] A change visible in a browser has a browser test (Playwright where the project has it),
      or the plan says why it cannot.
- [ ] The last step is Self-audit, and every step that writes tests runs them in that step.
- [ ] No gate bypass, and compatibility is handled the way the project's policy says.
- [ ] Docs, instruction files and project notes updates are named.
- [ ] The finish line is concrete and everything in scope reaches it.
- [ ] You applied the split rule. Past 12 steps, more than three areas or about 800 lines, the
      plan is split. Each part lands green on its own with at most 12 steps, carries its own
      context packet, adds no bridging shim, and names what it takes from earlier parts.
- [ ] Every plan file has the header with `Status: planned`, a `## Progress` checklist with
      exactly one line per step of section 4 (`[ ]`, or `[!]` for a step that waits on Needs
      from the user), and ends with an empty `## Execution report`.
- [ ] The file names say what each plan or part is about.
- [ ] Section 8 directs the implementer to finish routine work as it comes up and reserve added
      items for required work with a concrete blocker.
- [ ] Every repository the plan changes was named by the job, has a current supplement, and is
      in the `Repositories:` line with its own `Verified-at`; a change any other repository needs
      is a `[!]` line.
- [ ] The plan asks the user nothing: every choice is a decision with its reason, and "Needs
      from the user" holds only what the user must physically supply.
