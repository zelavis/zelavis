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
   - anything else not `done`: `Continue the plan in <path>. Start with its section 8.`
   - For a split plan, only the first part that is neither `done` nor `partly done` gets a line,
     since parts run in order and a part left with only `[!]` lines holds nothing back.
4. Mention a plan that says `done` as waiting for cleanup (the next planning run deletes it).
5. If there are no plans, say so in one line.

## If the job is `refresh`

When the job is just `refresh`, do only step 0 of Phase 1 (supplement, lessons, removing finished
plans, refreshing open plans) and report what changed. Write no new plan.

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
- **Step 0 runs in every named repository**: its supplement is created on the first run there
  (that run is the repository's initializer) and kept current on every run after, its lessons,
  finished plans and open plans are handled there as well. Read each one's own instruction
  files, gates and conventions: a change in a repository follows that repository's rules, and
  where two repositories' rules differ, each binds its own files.
- **One plan, in the home.** Steps that change another repository say which in their Files
  line (`fuzor: src/router.ts`), run their check from that repository's root, and come before
  the home steps that rely on them. Section 1 gives each repository its own System today and
  Pattern to mirror, and section 7 runs each repository's own full verification. Say how the
  home picks up the change (a sibling checkout it builds from, a workspace link, a local
  path), and never plan a publish or release of the other repository unless the job asks for
  one: that is outside the repositories, so it is a `[!]` line.
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
  unless the job itself asks for them. They are left undone and recorded as `[!]`, never asked
  about.

## Phase 1: Understand the project and the job

0. **First, before anything else, make sure the project supplement exists and is current**, in
   every repository the job names (see [Which repositories](#which-repositories)).
   Look for `.agents/references/plan-writer.md` at each repository root, then follow
   [The project supplement](#the-project-supplement) below:
   - **Missing:** study the repository and create it.
   - **Present:** run its freshness check, and update it if anything it relies on has changed.
   - **Either way:** add the lessons from execution reports written since the last run, then
     remove finished plans and refresh the open ones (all three are described below the
     freshness check).

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
  reason) so it can be carried out even if the implementer has lost the earlier sections.
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
  check disagreeing with an old one that passes is a finding, never noise: it investigates it
  in its own session until it knows the cause, then fixes it when it is in scope or adds it to
  the checklist with the cause and the fix.
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

### Format

It starts with this header, which the freshness check reads:

```
<!-- plan-writer supplement
verified-at: <short git commit the content was last checked against>
verified-on: <YYYY-MM-DD>
lessons-through: <YYYY-MM-DD of the newest execution report learned from, or none>
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

The check cannot notice that a better example of a pattern has appeared somewhere it never
looked. That is acceptable: the supplement gives leads, and Phase 1 step 8 still checks every
claim the plan makes against the live code. If you find a better canonical example while
planning, put it in the supplement.

### Lessons from execution reports (every run)

After the freshness check, read the execution report entries in `.agents/plans/`, single plans
and parts alike, dated on or after `lessons-through` (a report from that same day may be newer
than the last run; a lesson the supplement already cites for that plan is not added again). A
plan worked on by several sessions has one entry per session, so read each of them. For each "Context the plan lacked" item and each
deviation:
- **True of the project in general** (it would matter to other jobs): add it to the section it
  belongs in, usually Traps, cited as `(lesson: <plan file name>)`.
- **A mistake in planning** (a wrong symbol, missing context, a step too large): add it to Traps
  as guidance for plan writers, such as "check X before citing it".
- **Specific to that one job**: skip it.
- **A gap or error in the instruction files**: do not fix it here. Report it in section 0 of the
  plan, with suggested wording for the instruction file.

Then set `lessons-through` to the newest report date you read. If there were no new reports,
change nothing.

**Then remove finished plans,** so `.agents/plans/` only ever holds open work:
- **Delete** a single plan whose `Status` is `done`, and a split plan's whole folder once its
  overview's `Status` is `done`, but only after you have read its report into the supplement.
- **Keep** everything `planned`, `in progress`, `stopped at step <n>`, `partly done` or
  `needs replanning`.
- **Done work stays findable:** the code it changed is in Git history and what it taught is in
  the supplement's lessons. The plan file itself is gone, since plans are never committed.
- **Report** each deleted plan by name in section 0 of the new plan.

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
Open added items (`A<n>`) are checked like steps. A line an implementer marked `[!]` "needs
replanning" is replanned: rewrite the step (or item) against the code as it is now, with its
context and check, and set it back to `[ ]`. Leave `[x]` lines and execution reports
untouched, and never drop a `[ ]` or `[!]` added item: one the code has since made true becomes
`[x]` with the commit that did it. When a change undoes a decision the plan
rests on, mark the plan `Status: needs replanning`, say why under its header, and replan it
before anything else. Set `Verified-at` to `HEAD` once a plan is checked, and change nothing in
a plan that needed no correction. Report each refreshed plan in section 0 of the new plan, and
when the job is only to refresh, report there in the chat instead.

Lesson citations are not paths, so the freshness check does not test them. Keep a lesson until
the code or the rules contradict it, then remove it.

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
- `[!]`: a line that needs something only the user can physically supply, an action outside the
  named repositories the job did not ask for, work outside the plan's scope, or replanning, with
  one line on what and why. It never blocks the other lines.

**Added items.** Work an implementer leaves behind is added to this checklist, never left in a
chat message or a report alone (see "Nothing left over lives only in chat" in section 8). An
added item is numbered `A1`, `A2` and so on, and goes after the last added item and before the
final Self-audit line, which always stays last:

```
- [x] 3. <step goal> (2026-11-03)
- [ ] 4. <step goal>
- [ ] A1. <what remains, in one sentence> (from step 3: <why it was left>; check: <what proves it done>)
- [ ] 5. Self-audit
```

Added items are worked like steps: in order, after the planned steps before Self-audit, unless
a later step needs one first, and each is `[x]` only when its own check passed. A plan is `done`
only when every line but `[!]` ones is `[x]`; with `[!]` lines left it ends `partly done`.

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
when it truly does not apply, and say so in one line.

### 0. Summary and finish line
- Two or three sentences on what changes and why.
- **In scope** and **Out of scope**, as bullets.
- **Done means**: checkable conditions covering behavior, tests, gates and docs.
- The reading of the job you chose, if it could be read more than one way.
- **Supplement**, per repository: created, updated (and what changed) or found current, the
  lessons added from execution reports, any conflicts or instruction-file gaps it flagged, and the finished plans
  it deleted.
- **Sources read**: the instruction files and references you read.

### 1. Context packet
The implementer reads this first and returns to it whenever unsure.
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
Ordered, small, each independently verifiable. For each step:
1. **Goal**: one sentence.
2. **Files**: exact paths, existing or **NEW**.
3. **Context**: the excerpts, rules and reason this step needs, repeated here and not merely
   referenced.
4. **Change**: what to add, edit or delete, with exact symbols, before/after where it helps, and
   the code to mirror (`path:line`).
5. **Depends on**: the step numbers it needs.
6. **Check**: the command or test that proves it works, the directory it runs from, and the
   expected result (exit code or exact output). A step that writes tests runs them here, at once,
   and sees them pass, and sees a new test fail first when it guards a fix.

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
>   on against the code before its step. When one no longer matches but the step's intent is
>   still clear, follow the code as it is and record the deviation; when the step's premise is
>   gone, mark it `[!]` ("needs replanning: <why>") and carry on with the steps that do not
>   depend on it. `Status: needs replanning` means the whole plan's premise is gone: end the
>   session with one line saying so (`/plan-writer refresh` replans it).
> - `Status: planned`: you are the first. Set `Status: in progress`.
> - Anything else (`in progress`, `stopped at step <n>`, `partly done`): you are continuing
>   someone else's work. First read every entry under `## Execution report`. Then confirm the
>   last `[x]` step's check still passes. If it fails, find out why: fix it when the cause is in
>   this plan's own work, otherwise add it as an item, and carry on. Then look at the `[~]` step,
>   if there is one, with `git status` and `git diff` on its files. Finish it if its change is
>   partly there, or redo it if it is wrong; never redo a step marked `[x]`. Check each `[!]`
>   line too: when what it waited for is now there (the user supplied it, or the job now names
>   the repository or the action), set it to `[ ]` and work it like any other line; a `[!]`
>   "needs replanning" stays for `/plan-writer refresh`. Then set `Status: in progress`.
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
> **Nothing left over lives only in chat.** Whenever a step leaves anything not done, not
> proven, deferred, "later", "not built", "not done now", "not done yet", a known gap or a
> follow-up, however you would phrase it, add it to `## Progress` as an added item (`A<n>`,
> before the Self-audit line, with where it came from, why it was left and the check that will
> prove it) before you mark the step `[x]`. Never hide it in the step's one-line note. An item
> inside this plan's scope is `[ ]` and yours to finish: keep working through the checklist,
> however long it takes, until no `[ ]` line is left. An item that needs something only the user
> can physically supply, or lies outside the plan's scope, is `[!]`; record it and carry on with
> the rest.
>
> **Do not list leftovers to the user.** After a step, and in your final report, never write
> lists headed "Not done", "Not proven", "Later", "Not built" or the like. Say only how many
> items you added and which kind, in one line: "Added 3 items to the checklist (A4–A6), 1 needs
> you (A6)." The checklist is where they live; the user reads it there.
>
> Read section 1 first and return to it whenever you are unsure. Carry out section 4 step by step,
> in order, and run each step's check before starting the next. Tests you write are run in the
> same step, before you move on; never leave them for the end. Do not redesign, rename or
> "improve" anything the plan did not ask for. Match the surrounding code's style, naming and
> comment density.
>
> *(Only when the header has a `Repositories:` line.)* Each step's Files line names the
> repository it changes. Run its check from that repository's root, and follow that
> repository's own instruction files for its files. Compare each repository with its own
> `Verified-at` commit. Self-audit re-reads the diff and runs the full verification in every
> repository the plan names. Change no repository the plan does not name.
>
> **When the plan and the code disagree, decide; never improvise and never stop to ask:**
> - a referenced file or symbol does not exist or differs from the plan: find where it went.
>   When the step's intent is still clear, follow the code and record the deviation; when its
>   premise is gone, mark the step `[!]` ("needs replanning: <why>") and carry on with the steps
>   that do not depend on it;
> - a check fails and the cause is not a simple mistake in your own change: investigate until
>   you know the cause, fix it when it is inside this plan's scope, otherwise add it as an item;
> - a gate would need a suppression, baseline entry, wrapper or shim to pass: never add one.
>   Make the honest change pass; when that needs work outside this plan, mark the step `[!]`
>   with the reason and carry on;
> - the plan contradicts the project's instruction files: those win. Follow them and record
>   where they conflict.
>
> **An unexpected result is a finding, never noise**: two checks that disagree, a diagnostic
> that never settles, a number far from what the plan expects. Investigate it in this session
> until you know its cause, even when every check passes. If the fix stays inside this plan's
> files and rules, make it and test it; otherwise add it as an item with its cause and the fix.
> Never report it as "unexplained" without having looked.
>
> *(List the patterns this project forbids, taken from its rules and gates.)* Never edit
> generated output. Do not commit, push or publish unless told to.
>
> **Self-audit before you report done** (the plan's last step). Check your own work once more:
> - re-read your whole diff (`git diff`, plus new files) against sections 1–5: every step's change
>   is there, nothing is there the plan did not ask for, and no other person's file was touched;
> - every item of Done means holds, checked, not assumed;
> - rerun every test the plan added or touched, and the project's full verification, and see
>   them pass now, after your last edit;
> - search your diff for the forbidden patterns listed above, leftover debug output, temporary
>   files and TODOs you added;
> - every unexpected result you met has a known cause;
> - no `[ ]` or `[~]` line is left above Self-audit, and every leftover you noticed anywhere (your
>   notes, your diff's comments, test output, this report) is an added item.
> Fix what the audit finds (only inside the plan's scope), rerun the checks, and record the audit
> and what it found in your report.
>
> When you finish or stop, add your own entry under `## Execution report` at the end of this
> file, below any earlier entries, which you never edit. Head it `### Session <n>: <date>`:
> - the final status, and the steps you carried out. Update the `Status` line too, and in a
>   split plan the status table and `Status` line in `00-overview.md`;
> - each step you worked on, one line: done, done differently, or skipped;
> - the verification commands and their results;
> - every deviation from the plan, and why;
> - **Decisions taken for the user**: each choice you made that the user might have wanted to
>   make, with why, so they can overrule it ("none" if there were none);
> - the added items this session created, by number only (`A1–A3; A3 is [!]`), since their
>   text lives in `## Progress`;
> - **Context the plan lacked**: what you had to find out yourself, or got wrong at first, that
>   the plan should have told you. Write "none" if there was nothing.
>
> Then give the user the same report, shortened, with the added items and the decisions taken as
> counts only. It asks nothing.

## Self-check before you hand over the plan

- [ ] `Verified-at` is the commit you checked every citation against.
- [ ] You read the project's instruction files and their linked references for the areas
      touched, and the project supplement is current.
- [ ] Every named path, symbol, route, command and helper is cited as `path:line` or marked
      **NEW**, and you checked each one.
- [ ] No "something like", "e.g.", "as appropriate" or open choice is left for the implementer.
- [ ] Each step can be carried out on its own context alone and ends with a check.
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
- [ ] Section 8 keeps "Decide, don't ask", "Nothing left over lives only in chat" and "Do not
      list leftovers to the user" word for word: adapt the rest of the block, never those rules.
- [ ] Every repository the plan changes was named by the job, has a current supplement, and is
      in the `Repositories:` line with its own `Verified-at`; a change any other repository needs
      is a `[!]` line.
- [ ] The plan asks the user nothing: every choice is a decision with its reason, and "Needs
      from the user" holds only what the user must physically supply.
