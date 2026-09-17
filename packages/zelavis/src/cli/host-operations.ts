import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis host-operations <catalog|submit|get|audit> [operation|id] [--limit N] [--version V] [--project ID] [--arg name=value]... [--deadline-ms N] [--url URL] [--token TOKEN] [--json]";

/**
 * `zelavis host-operations` — release-signed host operations through the JS
 * SDK client, so the CLI cannot drift from `client.hostOperations.*`.
 */
export async function runHostOperationsCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  const operationArguments: Record<string, string> = {};
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let version: string | undefined;
  let projectId: string | undefined;
  let deadlineMs: number | undefined;
  let limit: number | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage); return; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    if (!["--url", "--token", "--version", "--project", "--arg", "--deadline-ms", "--limit"].includes(flag)) {
      throw new Error(`Unknown host-operations option "${arg}".`);
    }
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (value === undefined || value === "") throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--version") version = value;
    if (flag === "--project") projectId = value;
    if (flag === "--limit") {
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error("--limit requires an integer.");
    }
    if (flag === "--deadline-ms") {
      deadlineMs = Number(value);
      if (!Number.isSafeInteger(deadlineMs)) throw new Error("--deadline-ms requires an integer.");
    }
    if (flag === "--arg") {
      const equals = value.indexOf("=");
      if (equals < 1) throw new Error("--arg requires name=value.");
      const name = value.slice(0, equals);
      if (Object.hasOwn(operationArguments, name)) throw new Error(`--arg ${name} was given twice.`);
      operationArguments[name] = value.slice(equals + 1);
    }
  }

  const [action, target, ...rest] = positional;
  if (!action) { console.log(usage); return; }
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const print = (value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());

  if (action === "catalog") {
    const operations = await client.hostOperations.catalog();
    print({ operations }, () =>
      operations.map((entry) =>
        `${entry.operation}@${entry.version}\t${entry.authorization.scope}\t${entry.authorization.permission}\t${Object.keys(entry.arguments).join(",")}`,
      ).join("\n") || "No requestable host operations.");
    return;
  }
  if (action === "submit") {
    if (!target) throw new Error("host-operations submit requires an operation name.");
    const operation = await client.hostOperations.submit({
      operation: target,
      ...(version ? { version } : {}),
      ...(projectId ? { projectId } : {}),
      arguments: operationArguments,
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
    });
    print({ operation }, () => `Submitted ${operation.operationId} (${operation.agent?.status ?? "unknown"}).`);
    return;
  }
  if (action === "audit") {
    const records = await client.hostOperations.audit({
      ...(projectId ? { projectId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    print({ records }, () =>
      records.map((record) =>
        `${record.requestedAt}\t${record.operationId}\t${record.operation}@${record.version}\t${record.projectId ?? "-"}\t${record.actorId}`,
      ).join("\n") || "No host operation records.");
    return;
  }
  if (action === "get") {
    if (!target) throw new Error("host-operations get requires an operation id.");
    const operation = await client.hostOperations.get(target);
    print({ operation }, () =>
      `${operation.operationId}\t${operation.operation}@${operation.version}\t${operation.agent?.status ?? "unknown"}\t${operation.actorId}`);
    return;
  }
  throw new Error(`Unknown host-operations command "${action}". ${usage}`);
}
