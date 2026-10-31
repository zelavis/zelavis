import type { BackupTarget, ForeignDrill } from "../db/node-backups.js";
import { bodyFlag, required, runTable, type CliTable } from "./command-table.js";

const usage =
  "zelavis backups <schedules|create-schedule|delete-schedule|run|runs|verify|restore|drill|drill-from> [name] [run-id] [--data JSON] [--confirm NAME] [--schedule NAME] [--recovery-key KEY] [--target-dir PATH] [--target JSON] [--url URL] [--token TOKEN] [--json]";

/** `zelavis backups` — the Platform's scheduled, encrypted, off-site backups of its System Store, through `client.runtime.backups`. */
const table: CliTable = {
  name: "backups",
  usage,
  valued: ["--data", "--confirm", "--schedule", "--recovery-key", "--target-dir", "--target"],
  actions: {
    schedules: {
      run: (input) => input.client.runtime.backups.schedules().then((schedules) => ({ schedules })),
      text: (result: { schedules: readonly { name: string; cron: string; keep: number; target: { kind: string; location: string }; keyFingerprint: string; nextRunAt?: string }[] }) =>
        result.schedules.map((entry) => `${entry.name}\t${entry.cron}\tkeep ${entry.keep}\t${entry.target.kind} ${entry.target.location}\tkey ${entry.keyFingerprint}${entry.nextRunAt ? `\tnext ${entry.nextRunAt}` : ""}`).join("\n") || "No backup schedules.",
    },
    "create-schedule": {
      run: (input) => input.client.runtime.backups.createSchedule(bodyFlag(input, "--data", "backups create-schedule")),
      text: (result: { name: string; recoveryKey: string }) => `Created backup schedule ${result.name}. Recovery key (shown once; keep it off this host): ${result.recoveryKey}`,
    },
    "delete-schedule": {
      run: (input) => {
        const name = required(input, 0, "A schedule name");
        if (input.flags.get("--confirm") !== name) throw new Error(`backups delete-schedule stops schedule ${name}; repeat it with --confirm ${name}.`);
        return input.client.runtime.backups.deleteSchedule({ name, confirm: name });
      },
      text: (result: { name: string }) => `Deleted backup schedule ${result.name}; its runs stay at the target.`,
    },
    run: {
      run: (input) => input.client.runtime.backups.run(required(input, 0, "A schedule name")),
      text: (result: { runId: string; status: string; bytes?: number; error?: string }) => result.status === "ok" ? `Backed up ${result.bytes} bytes as run ${result.runId}.` : `Backup run ${result.runId} failed: ${result.error}`,
    },
    runs: {
      run: (input) => {
        const schedule = input.flags.get("--schedule");
        return input.client.runtime.backups.runs(schedule === undefined ? undefined : { schedule }).then((runs) => ({ runs }));
      },
      text: (result: { runs: readonly { schedule: string; runId: string; status: string; verified?: boolean; restoredTo?: string }[] }) =>
        result.runs.map((entry) => `${entry.schedule}\t${entry.runId}\t${entry.status}${entry.verified === undefined ? "" : `\tverified ${entry.verified}`}${entry.restoredTo ? `\trestored to ${entry.restoredTo}` : ""}`).join("\n") || "No backup runs.",
    },
    verify: {
      run: (input) => input.client.runtime.backups.verify({ schedule: required(input, 0, "A schedule name"), runId: required(input, 1, "A run id") }),
      text: (result: { runId: string; verified?: boolean }) => `Run ${result.runId} ${result.verified ? "decrypts and matches its manifest" : "does NOT verify"}.`,
    },
    drill: {
      run: (input) => input.client.runtime.backups.drill({ schedule: required(input, 0, "A schedule name"), ...(input.positional[1] === undefined ? {} : { runId: input.positional[1] }) }),
      text: (result: { runId: string; drill?: { ok: boolean; rtoMs: number; rpoMs: number; records?: number; error?: string } }) => result.drill?.ok
        ? `Drill of run ${result.runId}: restored in ${result.drill.rtoMs} ms (RTO), data ${Math.round(result.drill.rpoMs / 1000)} s old (RPO), ${result.drill.records ?? 0} records.`
        : `Drill of run ${result.runId} failed: ${result.drill?.error}`,
    },
    "drill-from": {
      run: (input) => {
        const schedule = required({ ...input, positional: [input.flags.get("--schedule") ?? ""] }, 0, "--schedule");
        const recoveryKey = required({ ...input, positional: [input.flags.get("--recovery-key") ?? ""] }, 0, "--recovery-key");
        const directory = input.flags.get("--target-dir");
        if ((directory === undefined) === !input.flags.has("--target")) throw new Error("backups drill-from reads the run from --target-dir PATH or --target JSON (an s3 target), one of them.");
        const target = directory === undefined ? bodyFlag<BackupTarget>(input, "--target", "backups drill-from") : { kind: "directory" as const, path: directory };
        return input.client.runtime.backups.drillFrom({ target, schedule, recoveryKey, ...(input.positional[0] === undefined ? {} : { runId: input.positional[0] }) });
      },
      text: (result: ForeignDrill) => result.ok
        ? `Drill of ${result.schedule} run ${result.runId} on this machine: restored in ${result.rtoMs} ms (RTO), data ${Math.round(result.rpoMs / 1000)} s old (RPO)` +
          (result.tenants === undefined ? "" : `, ${result.tenants} Tenants`) + (result.records === undefined ? "" : `, ${result.records} records`) +
          (result.app === undefined ? "" : `, ${result.app.recipe} with ${result.app.captured.join(", ") || "nothing"} captured${result.app.missing.length === 0 ? "" : ` (${result.app.missing.join(", ")} not captured)`}`) + "."
        : `Drill of ${result.schedule} run ${result.runId} failed: ${result.error}`,
    },
    restore: {
      run: (input) => {
        const key = input.flags.get("--recovery-key");
        return input.client.runtime.backups.restore({ schedule: required(input, 0, "A schedule name"), runId: required(input, 1, "A run id"), ...(key === undefined ? {} : { recoveryKey: key }) });
      },
      text: (result: { runId: string; restoredTo?: string }) => `Restored run ${result.runId} to ${result.restoredTo}; apply it with the Platform stopped: zelavis system-store import ${result.restoredTo}/system-store/records.jsonl --confirm import`,
    },
  },
};

export function runBackupsCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
