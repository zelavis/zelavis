import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { integration, integrationValue, present } from "../core/runtime/effect-boundary.js";
import type { ZelavisProjectRecord } from "../project.js";
import { createZelavisClient, type ZelavisTenantBackup, type ZelavisTenantRestoreMode } from "../sdk/fetch.js";

const usage =
  "zelavis projects <list|recipes|versions|setup|setup-audit|get|create|rename|start|stop|restart|upgrade|switch-version|logs|remove|tenants|system-views|create-tenant|delete-tenant|branch-tenant|merge-branch|recovery-window|workflows|backup-schedules|create-backup-schedule|delete-backup-schedule|run-backup|backup-runs|verify-backup|restore-backup|drill-backup|storage|export-tenant|export-stream|images|create-image|delete-image|verify-image|prune-images|restore-tenant> [id|name] [new-name] [--id ID] [--recipe NAME] [--engine-version EXACT] [--method ID] [--software-version V] [--no-start] [--restart] [--reveal] [--install-host-packages] [--tenant ID] [--table NAME] [--confirm ID] [--to ID] [--view NAME] [--limit N] [--after CURSOR] [--output FILE] [--file BACKUP.json] [--into empty|purge|merge] [--outbox leave|copy] [--as-of CURSOR|--as-of-time ISO] [--dry-run] [--resolve JSON] [--data JSON] [--recovery-key KEY] [--schedule NAME] [--durability crash|power] [--until-consistent] [--storage sqlite|lmdb|rocksdb] [--keep N] [--url URL] [--token TOKEN] [--json]";

/**
 * A backup file read back, checked only for being one.
 *
 * The restore checks the format, the Tenant and every identifier itself; this
 * is so that a wrong file fails here with its name rather than as a request.
 */
const readBackup = (text: string, file: string): ZelavisTenantBackup => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const candidate = parsed as { readonly tenantId?: unknown; readonly events?: unknown; readonly parts?: unknown } | null;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)
    || typeof candidate.tenantId !== "string" || (!Array.isArray(candidate.events) && !Array.isArray(candidate.parts))) {
    throw new Error(`${file} is not a Tenant backup.`);
  }
  return candidate as ZelavisTenantBackup;
};

/**
 * `zelavis projects` — the Project routes through the JS SDK client.
 *
 * Commands call `client.projects.*` rather than their own requests, so the CLI
 * cannot drift from the SDK's contract. `--json` prints the SDK result as-is;
 * failures are reported by `runCli` with the HTTP status and body.
 */
const projectsCommand = Effect.fn("ProjectsCLI.command")(function* (args: readonly string[]) {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let id: string | undefined;
  let recipe: string | undefined;
  let engineVersion: string | undefined;
  let method: string | undefined;
  let softwareVersion: string | undefined;
  let start = true;
  let installHostPackages = false;
  let restart = false;
  let reveal = false;
  let tenant: string | undefined;
  let table: string | undefined;
  let confirm: string | undefined;
  let view: string | undefined;
  let limit: number | undefined;
  let after: string | undefined;
  let output: string | undefined;
  let file: string | undefined;
  let into: string | undefined;
  let to: string | undefined;
  let outbox: string | undefined;
  let storage: string | undefined;
  let keep: number | undefined;
  let asOf: string | undefined;
  let dryRun = false;
  let durability: string | undefined;
  let data: string | undefined;
  let recoveryKey: string | undefined;
  let scheduleFilter: string | undefined;
  let resolve: string | undefined;
  let asOfTime: string | undefined;
  let untilConsistent = false;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--install-host-packages") { installHostPackages = true; continue; }
    if (arg === "--no-start") { start = false; continue; }
    if (arg === "--restart") { restart = true; continue; }
    if (arg === "--reveal") { reveal = true; continue; }
    if (arg === "--until-consistent") { untilConsistent = true; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return;
    }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token", "--id", "--recipe", "--engine-version", "--method", "--software-version", "--tenant", "--table", "--confirm", "--view", "--limit", "--after", "--output", "--file", "--into", "--to", "--outbox", "--storage", "--keep", "--as-of", "--as-of-time", "--resolve", "--data", "--recovery-key", "--schedule", "--durability"].includes(flag)) {
      throw new Error(`Unknown projects option "${arg}".`);
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--id") id = value;
    if (flag === "--recipe") recipe = value;
    if (flag === "--engine-version") engineVersion = value;
    if (flag === "--method") method = value;
    if (flag === "--software-version") softwareVersion = value;
    if (flag === "--tenant") tenant = value;
    if (flag === "--table") table = value;
    if (flag === "--confirm") confirm = value;
    if (flag === "--view") view = value;
    if (flag === "--after") after = value;
    if (flag === "--limit") {
      limit = Number(value);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("--limit requires a positive integer.");
    }
    if (flag === "--output") output = value;
    if (flag === "--file") file = value;
    if (flag === "--into") into = value;
    if (flag === "--to") to = value;
    if (flag === "--outbox") outbox = value;
    if (flag === "--storage") storage = value;
    if (flag === "--as-of") asOf = value;
    if (flag === "--resolve") resolve = value;
    if (flag === "--data") data = value;
    if (flag === "--durability") durability = value;
    if (flag === "--recovery-key") recoveryKey = value;
    if (flag === "--schedule") scheduleFilter = value;
    if (flag === "--as-of-time") asOfTime = value;
    if (flag === "--keep") {
      keep = Number(value);
      if (!Number.isSafeInteger(keep) || keep < 1) throw new Error("--keep requires a positive integer.");
    }
  }

  const [action, target, ...rest] = positional;
  if (!action) {
    console.log(usage);
    return;
  }
  const extra = ["verify-backup", "restore-backup", "drill-backup"].includes(action) ? 2
    : ["rename", "create-image", "delete-image", "verify-image", "delete-backup-schedule", "run-backup"].includes(action) ? 1 : 0;
  if (rest.length > extra) throw new Error(`Unexpected argument "${rest[extra]}". ${usage}`);
  if (storage !== undefined && action !== "create-image") throw new Error("--storage is only supported by projects create-image.");
  if (reveal && action !== "setup") throw new Error("--reveal is only supported by projects setup.");
  if (restart && action !== "upgrade") throw new Error("--restart is only supported by projects upgrade.");
  if (installHostPackages && action !== "create") throw new Error("--install-host-packages is only supported by projects create.");
  if ((method || softwareVersion) && action !== "create") throw new Error("--method and --software-version are only supported by projects create.");
  if (engineVersion && !["create", "upgrade", "switch-version"].includes(action)) throw new Error("--engine-version is only supported by create, upgrade and switch-version.");
  if (tenant && !["create-tenant", "delete-tenant", "branch-tenant", "merge-branch", "recovery-window", "export-tenant", "export-stream", "restore-tenant", "system-views"].includes(action)) throw new Error("--tenant is only supported by projects create-tenant, delete-tenant, branch-tenant, merge-branch, recovery-window, export-tenant, export-stream, restore-tenant and system-views.");
  if (untilConsistent && action !== "export-stream") throw new Error("--until-consistent is only supported by projects export-stream.");
  if (action === "export-stream" && !tenant) throw new Error("projects export-stream requires --tenant <id>.");
  if (to !== undefined && action !== "branch-tenant" && action !== "merge-branch") throw new Error("--to is only supported by projects branch-tenant and merge-branch.");
  if (outbox !== undefined && action !== "branch-tenant") throw new Error("--outbox is only supported by projects branch-tenant.");
  if (outbox !== undefined && outbox !== "leave" && outbox !== "copy") throw new Error("--outbox is leave or copy.");
  if (view !== undefined && action !== "system-views") throw new Error("--view is only supported by projects system-views.");
  if ((limit !== undefined || after !== undefined) && !["system-views", "export-stream", "workflows"].includes(action)) throw new Error("--limit and --after are only supported by projects system-views, export-stream and workflows.");
  if ((limit !== undefined || after !== undefined) && action === "system-views" && view === undefined) throw new Error("--limit and --after page one view; name it with --view.");
  if (after !== undefined && untilConsistent) throw new Error("--until-consistent starts an export; it takes no --after.");
  if (confirm !== undefined && !["delete-tenant", "delete-image", "delete-backup-schedule"].includes(action)) throw new Error("--confirm is only supported by projects delete-tenant, delete-image and delete-backup-schedule.");
  if (durability !== undefined && action !== "storage") throw new Error("--durability is only supported by projects storage.");
  if (data !== undefined && action !== "create-backup-schedule") throw new Error("--data is only supported by projects create-backup-schedule.");
  if (recoveryKey !== undefined && action !== "restore-backup") throw new Error("--recovery-key is only supported by projects restore-backup.");
  if (scheduleFilter !== undefined && action !== "backup-runs") throw new Error("--schedule is only supported by projects backup-runs.");
  if (keep !== undefined && action !== "prune-images") throw new Error("--keep is only supported by projects prune-images.");
  if ((dryRun || resolve !== undefined) && action !== "merge-branch") throw new Error("--dry-run and --resolve are only supported by projects merge-branch.");
  if ((asOf !== undefined || asOfTime !== undefined) && action !== "branch-tenant") throw new Error("--as-of and --as-of-time are only supported by projects branch-tenant.");
  if (table && action !== "create-tenant") throw new Error("--table is only supported by projects create-tenant.");
  if (output && !["export-tenant", "export-stream"].includes(action)) throw new Error("--output is only supported by projects export-tenant and export-stream.");
  if ((file || into) && action !== "restore-tenant") throw new Error("--file and --into are only supported by projects restore-tenant.");
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const requireTarget = (label: string) => {
    if (!target) throw new Error(`projects ${action} requires a Project ${label}.`);
    return target;
  };
  const print = (value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());
  const line = (project: ZelavisProjectRecord) =>
    `${project.id}\t${project.engineVersion ?? "current engine"}\t${project.runtime.status}\t${project.recipe.name}@${project.recipe.version}\t${project.runtimeKind}` +
    (project.recipeStatus?.state === "upgradeAvailable"
      ? `\tupgrade available: ${project.recipeStatus.version}`
      : project.recipeStatus?.state === "unavailable"
        ? "\trecipe not shipped: upgrade with --recipe"
        : "") +
    (project.isolation && project.isolation.shortfalls.length > 0
      ? `\tisolation: ${project.isolation.shortfalls.map((item) => `${item.requirement}(${item.enforcement})`).join(",")}`
      : "");

  switch (action) {
    case "list": {
      const result = yield* integration(() => client.projects.list());
      print(result, () => result.projects.map(line).join("\n") || "No Projects.");
      return;
    }
    case "recipes": {
      const recipes = yield* integration(() => client.projects.recipes());
      print({ projectRecipes: recipes }, () =>
        recipes.map((entry) => `${entry.name}\t${entry.runtimeKinds.join(",")}\t${entry.title}` +
          (entry.install ? `\tmethods ${entry.install.methods.map((method) => method.id).join(",")}\tsoftware ${entry.install.software.map((software) => software.version).join(",")}` : "")).join("\n"));
      return;
    }
    case "versions": {
      const result = yield* integration(() => client.projects.versions(target));
      print(result, () => result.selectable ? result.versions.map(entry => `${entry.version}\t${entry.status}${entry.version === result.current ? "\tselected" : ""}${entry.error ? `\t${entry.error}` : ""}`).join("\n") : result.reason ?? "Independent engine versions are unavailable.");
      return;
    }
    case "setup": {
      const values = yield* integration(() => reveal ? client.projects.revealSetup(requireTarget("id")) : client.projects.setup(requireTarget("id")));
      print({ values }, () => values.map(value => `${value.label}\t${value.secret && value.value === undefined ? "(secret: use --reveal)" : value.value}`).join("\n") || "This Project has no setup values.");
      return;
    }
    case "setup-audit": {
      const reveals = yield* integration(() => client.projects.setupReveals(requireTarget("id")));
      print({ reveals }, () => reveals.map(entry => `${new Date(entry.at).toISOString()}\t${entry.principalType}:${entry.principalId}\t${entry.revealed.join(",")}`).join("\n") || "No reveals.");
      return;
    }
    case "switch-version": {
      if (!engineVersion) throw new Error("projects switch-version requires --engine-version <exact version>.");
      const project = yield* integration(() => client.projects.switchVersion(requireTarget("id"), engineVersion!));
      print({ project }, () => `Selected ${line(project)}`);
      return;
    }
    case "get":
    case "start":
    case "stop":
    case "restart": {
      const projectId = requireTarget("id");
      const project = yield* integration(() => client.projects[action](projectId));
      print({ project }, () => line(project));
      return;
    }
    case "create": {
      const project = yield* integration(() => client.projects.create({
        name: requireTarget("name"),
        ...(id ? { id } : {}),
        ...(recipe ? { recipeName: recipe } : {}),
        ...(engineVersion ? { engineVersion } : {}),
        ...(method ? { method } : {}),
        ...(softwareVersion ? { softwareVersion } : {}),
        start,
        ...(installHostPackages ? { installHostPackages: true } : {}),
      }));
      print({ project }, () => `Created ${line(project)}`);
      return;
    }
    case "upgrade": {
      const project = yield* integration(() => client.projects.upgrade(requireTarget("id"), {
        ...(restart ? { restart: true } : {}),
        ...(recipe ? { recipeName: recipe } : {}),
        ...(engineVersion ? { engineVersion } : {}),
      }));
      print({ project }, () => `Upgraded ${line(project)}`);
      return;
    }
    case "rename": {
      const name = rest[0];
      if (!name) throw new Error("projects rename requires a new Project name.");
      const project = yield* integration(() => client.projects.update(requireTarget("id"), {
        name,
      }));
      print({ project }, () => `Renamed ${line(project)}`);
      return;
    }
    case "logs": {
      const logs = yield* integration(() => client.projects.logs(requireTarget("id")));
      print({ logs }, () => logs.map((entry) => `${entry.timestamp} ${entry.stream} ${entry.message}`).join("\n"));
      return;
    }
    case "remove": {
      const result = yield* integration(() => client.projects.remove(requireTarget("id")));
      print(result, () => `Removed ${target}.`);
      return;
    }
    case "tenants": {
      const tenants = yield* integration(() => client.projects.tenants(requireTarget("id")));
      const counts = (entry: { readonly tables: number; readonly documents: number; readonly records: number; readonly bytes: number }) =>
        `${entry.tables} tables\t${entry.documents} documents\t${entry.records} stored records\t${entry.bytes} bytes`;
      // A divided Tenant is one line of totals, then one indented line per part with its own shard and counts.
      const lines = (entry: (typeof tenants)[number]) => [
        `${entry.tenantId}\t${entry.shard ?? `divided into ${entry.parts?.length ?? 0} parts`}\t${counts(entry)}`,
        ...(entry.parts ?? []).map((part) => `  ${entry.tenantId}#${part.part}\t${part.shard}\t${counts(part)}`),
      ];
      print({ tenants }, () => tenants.length === 0 ? "No Tenants hold data." : tenants.flatMap(lines).join("\n"));
      return;
    }
    case "system-views": {
      const options = tenant ? { tenantId: tenant } : undefined;
      if (view === undefined) {
        const views = yield* integration(() => client.projects.systemViews(requireTarget("id"), options));
        print(views, () => JSON.stringify(views, null, 2));
        return;
      }
      const rows = yield* integration(() => client.projects.systemView(requireTarget("id"), view, { ...options, ...(limit === undefined ? {} : { limit }), ...(after === undefined ? {} : { after }) }));
      print(rows, () => JSON.stringify(rows, null, 2));
      return;
    }
    case "create-tenant": {
      if (!tenant || !table) throw new Error("projects create-tenant requires --tenant <id> and --table <name>.");
      const created = yield* integration(() => client.projects.createTenant(requireTarget("id"), { tenantId: tenant, table }));
      print({ tenantId: tenant, table: created.name }, () => `Created Tenant ${tenant} with table ${created.name}.`);
      return;
    }
    case "delete-tenant": {
      if (!tenant) throw new Error("projects delete-tenant requires --tenant <id>.");
      // Irreversible, so the ID is typed a second time, as the dashboard and the HTTP route also ask.
      if (confirm !== tenant) throw new Error(`projects delete-tenant removes Tenant ${tenant} and its history for good; repeat it with --confirm ${tenant}.`);
      const removed = yield* integration(() => client.projects.deleteTenant(requireTarget("id"), { tenantId: tenant, confirm }));
      print(removed, () => `Removed Tenant ${removed.tenant} (${removed.records} records) from ${removed.shard}.`);
      return;
    }
    case "branch-tenant": {
      if (!tenant || !to) throw new Error("projects branch-tenant requires --tenant <id> and --to <new id>.");
      const branched = yield* integration(() => client.projects.branchTenant(requireTarget("id"), {
        tenantId: tenant, into: to, ...(outbox === undefined ? {} : { outbox: outbox as "leave" | "copy" }),
        ...(asOf === undefined ? {} : { asOf }), ...(asOfTime === undefined ? {} : { asOfTime }),
      }));
      const where = branched.parts === undefined
        ? `on ${branched.shard}`
        : `in ${branched.parts.length} ${branched.parts.length === 1 ? "part" : "parts"} (${branched.parts.map((entry) => `${entry.part} on ${entry.shard}`).join(", ")})`;
      print(branched, () => `Branched Tenant ${branched.tenant} into ${branched.into} ${where}: ${branched.records} records, ${branched.events} events.`);
      return;
    }
    case "merge-branch": {
      if (!tenant) throw new Error("projects merge-branch requires --tenant <branch id>.");
      let resolutions: unknown;
      if (resolve !== undefined) {
        try { resolutions = JSON.parse(resolve); } catch { throw new Error("--resolve requires JSON: [{ \"collection\": …, \"id\": …, \"keep\": \"source\" | \"branch\" }]."); }
      }
      const merge = yield* integration(() => client.projects.mergeTenantBranch(requireTarget("id"), {
        tenantId: tenant, ...(to === undefined ? {} : { into: to }), ...(dryRun ? { dryRun } : {}),
        ...(resolutions === undefined ? {} : { resolve: resolutions as never }),
      }));
      print(merge, () => [
        `${merge.merged ? "Merged" : merge.dryRun ? "Would merge" : "Did not merge"} ${merge.branch} into ${merge.into}: ${merge.writes} writes, ${merge.deletes} deletes, ${merge.conflictCount} conflicts.`,
        ...merge.partitions.flatMap((entry) => entry.conflicts.map((conflict) => `conflict\t${entry.part ?? ""}\t${conflict.kind}\t${conflict.collection}${conflict.id === undefined ? "" : `/${conflict.id}`}`)),
        ...merge.partitions.flatMap((entry) => entry.unmerged.length === 0 ? [] : [`not merged${entry.part === undefined ? "" : ` (${entry.part})`}: ${entry.unmerged.join(", ")}`]),
      ].join("\n"));
      return;
    }
    case "backup-schedules": {
      const schedules = yield* integration(() => client.projects.backupSchedules(requireTarget("id")));
      print({ schedules }, () => schedules.length === 0 ? "No backup schedules." : schedules.map((entry) => `${entry.name}\t${entry.cron}\tkeep ${entry.keep}\t${entry.target.kind} ${entry.target.location}\tkey ${entry.keyFingerprint}${entry.nextRunAt === undefined ? "" : `\tnext ${entry.nextRunAt}`}`).join("\n"));
      return;
    }
    case "create-backup-schedule": {
      if (data === undefined) throw new Error("projects create-backup-schedule requires --data '{ \"name\": …, \"cron\": …, \"keep\": …, \"target\": … }'.");
      let input: unknown;
      try { input = JSON.parse(data); } catch { throw new Error("--data requires JSON."); }
      const schedule = yield* integration(() => client.projects.createBackupSchedule(requireTarget("id"), input as never));
      print({ schedule }, () => `Created backup schedule ${schedule.name}. Recovery key (shown once; keep it off this host): ${schedule.recoveryKey}`);
      return;
    }
    case "delete-backup-schedule": {
      const name = rest[0];
      if (!name) throw new Error("projects delete-backup-schedule requires a schedule name.");
      if (confirm !== name) throw new Error(`projects delete-backup-schedule stops schedule ${name}; repeat it with --confirm ${name}.`);
      const removed = yield* integration(() => client.projects.deleteBackupSchedule(requireTarget("id"), { name, confirm }));
      print({ removed }, () => `Deleted backup schedule ${removed.name}; its runs stay at the target.`);
      return;
    }
    case "run-backup": {
      const name = rest[0];
      if (!name) throw new Error("projects run-backup requires a schedule name.");
      const run = yield* integration(() => client.projects.runBackup(requireTarget("id"), name));
      print({ run }, () => run.status === "ok" ? `Backed up ${run.bytes} bytes in ${run.parts} parts as run ${run.runId}.` : `Backup run ${run.runId} failed: ${run.error}`);
      if (run.status !== "ok") process.exitCode = 1;
      return;
    }
    case "backup-runs": {
      const runs = yield* integration(() => client.projects.backupRuns(requireTarget("id"), scheduleFilter === undefined ? undefined : { schedule: scheduleFilter }));
      print({ runs }, () => runs.length === 0 ? "No backup runs." : runs.map((entry) => `${entry.schedule}\t${entry.runId}\t${entry.status}${entry.bytes === undefined ? "" : `\t${entry.bytes} bytes`}${entry.verified === undefined ? "" : `\tverified ${entry.verified}`}${entry.restoredTo === undefined ? "" : `\trestored to ${entry.restoredTo}`}`).join("\n"));
      return;
    }
    case "verify-backup": {
      const [schedule, runId] = rest;
      if (!schedule || !runId) throw new Error("projects verify-backup requires a schedule name and a run id.");
      const run = yield* integration(() => client.projects.verifyBackup(requireTarget("id"), { schedule, runId }));
      print({ run }, () => `Run ${runId} of ${schedule} ${run.verified ? "decrypts and matches its manifest" : "does NOT verify"}.`);
      if (!run.verified) process.exitCode = 1;
      return;
    }
    case "restore-backup": {
      const [schedule, runId] = rest;
      if (!schedule || !runId) throw new Error("projects restore-backup requires a schedule name and a run id.");
      const run = yield* integration(() => client.projects.restoreBackup(requireTarget("id"), { schedule, runId, ...(recoveryKey === undefined ? {} : { recoveryKey }) }));
      print({ run }, () => `Restored run ${runId} of ${schedule} to ${run.restoredTo}; open it as a database, or swap it in with the Project stopped.`);
      return;
    }
    case "storage": {
      const projectId = requireTarget("id");
      const choice = durability === undefined
        ? yield* integration(() => client.projects.databaseStorage(projectId))
        : yield* integration(() => client.projects.setDatabaseStorage(projectId, { durability: durability as "crash" | "power" }));
      print({ storage: choice }, () => `${choice.engine}, durability ${choice.durability}${choice.pending ? ` (${choice.pending} from the Project's next start)` : ""}.`);
      return;
    }
    case "drill-backup": {
      const [schedule, runId] = rest;
      if (!schedule) throw new Error("projects drill-backup requires a schedule name.");
      const run = yield* integration(() => client.projects.drillBackup(requireTarget("id"), { schedule, ...(runId === undefined ? {} : { runId }) }));
      const drill = run.drill;
      print({ run }, () => drill?.ok
        ? `Drill of run ${run.runId}: restored and opened in ${drill.rtoMs} ms (RTO); its data was ${Math.round(drill.rpoMs / 1000)} s old (RPO); ${drill.tenants ?? 0} Tenants, ${drill.records ?? 0} records.`
        : `Drill of run ${run.runId} failed: ${drill?.error}`);
      if (!drill?.ok) process.exitCode = 1;
      return;
    }
    case "workflows": {
      const executions = yield* integration(() => client.projects.workflowExecutions(requireTarget("id"), limit === undefined ? undefined : { limit }));
      print({ executions }, () => executions.length === 0 ? "No workflow executions." : executions.map((entry) =>
        `${entry.workflow}\t${entry.executionId}\t${entry.complete ? "complete" : "unfinished"}\t${entry.activities} activities${entry.parent === undefined ? "" : `\tparent ${entry.parent}`}`).join("\n"));
      return;
    }
    case "recovery-window": {
      if (!tenant) throw new Error("projects recovery-window requires --tenant <id>.");
      const window = yield* integration(() => client.projects.tenantRecoveryWindow(requireTarget("id"), tenant));
      print({ window }, () => window.partitions.map((entry) => `${entry.part ?? window.tenant}\tpositions ${entry.earliest}–${entry.latest}${entry.earliestAt === undefined ? "" : `\t${new Date(entry.earliestAt).toISOString()} – ${new Date(entry.latestAt ?? entry.earliestAt).toISOString()}`}${entry.compactedTo > 0 ? `\tcompacted to ${entry.compactedTo}` : ""}`).join("\n"));
      return;
    }
    case "export-tenant": {
      const backup = yield* integration(() => client.projects.exportTenant(requireTarget("id"), tenant ? { tenantId: tenant } : undefined));
      if (!output) {
        // The backup is the output, whatever the format flag says: redirect it
        // to a file, or hand it to restore-tenant.
        console.log(JSON.stringify(backup, null, 2));
        return;
      }
      // Created owner-only: a backup holds every record of the Tenant.
      const destination = output;
      yield* integration(() => writeFile(destination, `${JSON.stringify(backup)}\n`, { mode: 0o600 }));
      const events = "parts" in backup ? backup.parts.reduce((sum, entry) => sum + entry.backup.events.length, 0) : backup.events.length;
      const parts = "parts" in backup ? ` across ${backup.parts.length} parts` : "";
      print(
        { tenantId: backup.tenantId, events, ...("parts" in backup ? { parts: backup.parts.map((entry) => entry.part) } : {}), file: destination },
        () => `Exported ${events} events of Tenant ${backup.tenantId}${parts} to ${destination}.`,
      );
      return;
    }
    case "images": {
      const images = yield* integration(() => client.projects.databaseImages(requireTarget("id")));
      print({ images }, () => images.length === 0 ? "No database images." : images.map((entry) => `${entry.name}\t${entry.engine}\t${entry.createdAt}\t${entry.shards.length} shards\t${entry.keys} keys\t${entry.bytes} bytes`).join("\n"));
      return;
    }
    case "create-image": {
      const name = rest[0];
      if (!name) throw new Error("projects create-image requires an image name.");
      const engine = storage as "sqlite" | "lmdb" | "rocksdb" | undefined;
      const image = yield* integration(() => client.projects.createDatabaseImage(requireTarget("id"), { name, ...(engine === undefined ? {} : { engine }) }));
      print({ image }, () => `Imaged ${image.shards.length} shards (${image.keys} keys, ${image.bytes} bytes) as "${image.name}" in ${image.engine}.`);
      return;
    }
    case "delete-image": {
      const name = rest[0];
      if (!name) throw new Error("projects delete-image requires an image name.");
      if (confirm !== name) throw new Error(`projects delete-image removes image ${name} for good; repeat it with --confirm ${name}.`);
      const removed = yield* integration(() => client.projects.deleteDatabaseImage(requireTarget("id"), { name, confirm }));
      print({ removed }, () => `Removed image "${removed.name}" (${removed.bytes} bytes).`);
      return;
    }
    case "verify-image": {
      const name = rest[0];
      if (!name) throw new Error("projects verify-image requires an image name.");
      const verification = yield* integration(() => client.projects.verifyDatabaseImage(requireTarget("id"), name));
      print({ verification }, () => [`Image "${verification.name}" ${verification.ok ? "holds exactly what was written" : "does NOT hold what was written"}.`,
        ...verification.shards.map((shard) => `${shard.shard}\t${shard.ok ? "ok" : `failed: ${shard.problem}`}\t${shard.keys} keys`)].join("\n"));
      if (!verification.ok) process.exitCode = 1;
      return;
    }
    case "prune-images": {
      if (keep === undefined) throw new Error("projects prune-images requires --keep <N>, the newest images to keep.");
      const pruned = yield* integration(() => client.projects.pruneDatabaseImages(requireTarget("id"), { keep }));
      print({ pruned }, () => pruned.removed.length === 0 ? `Nothing removed; kept ${pruned.kept.length}.` : `Removed ${pruned.removed.join(", ")}; kept ${pruned.kept.length}.`);
      return;
    }
    case "export-stream": {
      // One page, or with --until-consistent every page up to the first consistent one, whose entries applied by
      // version are the Tenant as of one position per part (the same entries `export-tenant` carries).
      const projectId = requireTarget("id");
      const tenantId = tenant!;
      let page = yield* integration(() => client.projects.exportTenantPage(projectId, { tenantId, ...(after === undefined ? {} : { cursor: after }), ...(limit === undefined ? {} : { limit }) }));
      let result = page;
      let pages = 1;
      if (untilConsistent) {
        const entries = [...page.entries];
        while (!page.consistent) {
          const cursor = page.cursor;
          page = yield* integration(() => client.projects.exportTenantPage(projectId, { tenantId, cursor, ...(limit === undefined ? {} : { limit }) }));
          entries.push(...page.entries);
          pages += 1;
        }
        result = { ...page, entries };
      }
      if (output) {
        const destination = output;
        yield* integration(() => writeFile(destination, `${JSON.stringify(result)}\n`, { mode: 0o600 }));
        print({ tenantId, entries: result.entries.length, consistent: result.consistent, cursor: result.cursor, pages, file: destination },
          () => `Wrote ${result.entries.length} entries of Tenant ${tenantId} to ${destination} (${result.consistent ? "consistent" : "not yet consistent"}; continue with --after ${result.cursor}).`);
        return;
      }
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "restore-tenant": {
      if (!file) throw new Error("projects restore-tenant requires --file <backup.json>.");
      const backup = readBackup(yield* integrationValue(readFile(file, "utf8")), file);
      // The mode is passed as given: the restore refuses one it does not have,
      // with the same answer the SDK and HTTP get.
      const result = yield* integration(() => client.projects.restoreTenant(requireTarget("id"), backup, {
        ...(into ? { into: into as ZelavisTenantRestoreMode } : {}),
        ...(tenant ? { tenantId: tenant } : {}),
      }));
      print(result, () =>
        `Restored ${result.events} events into Tenant ${result.tenantId}${result.parts ? ` across ${result.parts.length} parts` : ""}` +
        (result.removed > 0 ? `, removing ${result.removed} records first` : "") +
        (result.superseded > 0 ? `, writing over ${result.superseded}` : "") + ".");
      return;
    }
    default:
      throw new Error(`Unknown projects command "${action}". ${usage}`);
  }
});

export function runProjectsCommand(args: readonly string[]): Promise<void> { return present(projectsCommand(args)); }
