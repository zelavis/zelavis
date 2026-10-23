import { Effect } from "effect";
import { present, integrationValue, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis data <collections|modalities|count|create-collection|set-columns|drop-collection|get|insert|update|delete|query|page|write|kv-get|kv-set|kv-delete|kv-scan|kv-changes|kv-write|kv-size|kv-clear|outbox|outbox-emit|outbox-remove> --project ID [collection-namespace-or-topic] [id-or-key] [--data JSON] [--where JSON] [--order JSON] [--operations JSON] [--emit JSON] [--ids ID,ID] [--prefix PREFIX] [--lower KEY] [--upper KEY] [--direction asc|desc] [--ttl-ms N|--expires-at ISO] [--limit N] [--after CURSOR] [--mode merge|replace] [--expected-version N] [--idempotency-key KEY] [--columns FIELD,FIELD|all] [--url URL] [--token TOKEN] [--json]";

/**
 * `zelavis data` — App data in one App Project, through the JS SDK client, so
 * the CLI cannot drift from `client.data(projectId).*`.
 *
 * There is no `--tenant`: the Tenant comes from whoever the token authenticates
 * as. An operator who needs to read another Tenant's records is doing an
 * operator's job and uses the dashboard or the Project's own database surface.
 */
export function runDataCommand(args: readonly string[]): Promise<void> {
    return present(Effect.gen(function* (): Effect.fn.Return<void, IntegrationFailure> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let projectId: string | undefined;
  let data: unknown;
  let where: unknown;
  let orderBy: unknown;
  let operations: unknown;
  let emit: unknown;
  let ids: ReadonlyArray<string> | undefined;
  let after: string | undefined;
  let mode: string | undefined;
  let idempotencyKey: string | undefined;
  let limit: number | undefined;
  let expectedVersion: number | undefined;
  let prefix: string | undefined;
  let lower: string | undefined;
  let upper: string | undefined;
  let direction: "asc" | "desc" | undefined;
  let expiresAt: string | undefined;
  let ttlMs: number | undefined;
  /** `null` is "all": every field indexed. */
  let columns: ReadonlyArray<string> | null | undefined;
  let json = false;

  const parseJson = (flag: string, value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`${flag} requires JSON.`);
    }
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    if (arg === "--help" || arg === "-h") { console.log(usage); return; }
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    const separator = arg.indexOf("=");
    const flag = separator === -1 ? arg : arg.slice(0, separator);
    const known = [
      "--url", "--token", "--project", "--data", "--where", "--order",
      "--operations", "--limit", "--after", "--mode", "--expected-version",
      "--idempotency-key", "--prefix", "--lower", "--upper", "--direction",
      "--expires-at", "--ttl-ms", "--columns", "--emit", "--ids",
    ];
    if (!known.includes(flag)) throw new Error(`Unknown data option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (value === undefined || value === "") throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--project") projectId = value;
    if (flag === "--after") after = value;
    if (flag === "--idempotency-key") idempotencyKey = value;
    if (flag === "--prefix") prefix = value;
    if (flag === "--lower") lower = value;
    if (flag === "--upper") upper = value;
    if (flag === "--expires-at") expiresAt = value;
    if (flag === "--direction") {
      if (value !== "asc" && value !== "desc") throw new Error("--direction must be asc or desc.");
      direction = value;
    }
    if (flag === "--mode") {
      if (value !== "merge" && value !== "replace") throw new Error("--mode must be merge or replace.");
      mode = value;
    }
    if (flag === "--data") data = parseJson(flag, value);
    if (flag === "--where") where = parseJson(flag, value);
    if (flag === "--order") orderBy = parseJson(flag, value);
    if (flag === "--operations") operations = parseJson(flag, value);
    if (flag === "--emit") emit = parseJson(flag, value);
    if (flag === "--ids") ids = value.split(",").map((id) => id.trim()).filter((id) => id !== "");
    if (flag === "--limit") {
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error("--limit requires an integer.");
    }
    if (flag === "--expected-version") {
      expectedVersion = Number(value);
      if (!Number.isSafeInteger(expectedVersion)) throw new Error("--expected-version requires an integer.");
    }
    if (flag === "--columns") {
      columns = value === "all" ? null : value.split(",").map((field) => field.trim()).filter((field) => field !== "");
    }
    if (flag === "--ttl-ms") {
      ttlMs = Number(value);
      if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("--ttl-ms requires a non-negative integer.");
    }
  }

  const [action, collection, documentId, ...rest] = positional;
  if (!action) { console.log(usage); return; }
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  if (!projectId) throw new Error("data commands require --project.");

  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const api = client.data(projectId);
  const print = (value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());
  const requireCollection = () => {
    if (!collection) throw new Error(`data ${action} requires a collection name.`);
    return collection;
  };
  const requireDocumentId = () => {
    if (!documentId) throw new Error(`data ${action} requires a document id.`);
    return documentId;
  };
  const requireData = () => {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(`data ${action} requires --data with a JSON object.`);
    }
    return data as Record<string, unknown>;
  };
  const keyed = idempotencyKey ? { idempotencyKey } : {};
  const clauses = {
    ...(Array.isArray(where) ? { where } : {}),
    ...(Array.isArray(orderBy) ? { orderBy } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  const describe = (document: { id: string; version: number }) =>
    `${document.id}\tv${document.version}`;

  if (action === "collections") {
    const collections = (yield* integrationValue(api.collections.list()));
    print({ collections }, () =>
      collections.map((entry) => `${entry.name}\t${entry.surface ?? "database"}`).join("\n")
      || "No collections.");
    return;
  }
  if (action === "count") {
    const count = yield* integrationValue(api.collections.count(requireCollection()));
    print({ count }, () => `${count}`);
    return;
  }
  if (action === "modalities") {
    const modalities = (yield* integrationValue(api.collections.modalities(requireCollection())));
    print({ modalities }, () => Object.entries(modalities)
      .filter(([name]) => name !== "collection")
      .map(([name, state]) => `${name}\t${(state as { status: string }).status}`)
      .join("\n"));
    return;
  }
  if (action === "create-collection") {
    const created = (yield* integrationValue(api.collections.create({
      name: requireCollection(),
      ...(columns === undefined || columns === null ? {} : { columns }),
    })));
    print({ collection: created }, () => `Created collection ${created.name}.`);
    return;
  }
  if (action === "set-columns") {
    if (columns === undefined) throw new Error("set-columns requires --columns FIELD,FIELD or --columns all.");
    const name = requireCollection();
    const result = (yield* integrationValue(api.collections.setColumns(name, columns)));
    print(result, () =>
      `${name} indexes ${result.columns === null ? "every field" : result.columns.join(", ")}; ` +
      `rewrote ${result.documents} document${result.documents === 1 ? "" : "s"}.`);
    return;
  }
  if (action === "get") {
    const document = (yield* integrationValue(api.documents.get(requireCollection(), requireDocumentId())));
    if (!document) {
      print({ document: null }, () => "Document not found.");
      process.exitCode = 1;
      return;
    }
    print({ document }, () => `${describe(document)}\t${JSON.stringify(document.data)}`);
    return;
  }
  if (action === "insert") {
    const document = (yield* integrationValue(api.documents.insert(requireCollection(), {
      ...keyed,
      ...(documentId ? { id: documentId } : {}),
      data: requireData(),
    })));
    print({ document }, () => `Inserted ${describe(document)}.`);
    return;
  }
  if (action === "update") {
    const document = (yield* integrationValue(api.documents.update(requireCollection(), requireDocumentId(), {
      ...keyed,
      data: requireData(),
      ...(mode ? { mode: mode as "merge" | "replace" } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    })));
    print({ document }, () => `Updated ${describe(document)}.`);
    return;
  }
  if (action === "delete") {
    const deleted = (yield* integrationValue(api.documents.delete(requireCollection(), requireDocumentId(), {
      ...keyed,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    })));
    print({ deleted }, () => deleted ? "Deleted." : "No such document.");
    if (!deleted) process.exitCode = 1;
    return;
  }
  if (action === "query") {
    const documents = (yield* integrationValue(api.documents.query(requireCollection(), clauses)));
    print({ documents }, () =>
      documents.map((document) => `${describe(document)}\t${JSON.stringify(document.data)}`).join("\n")
      || "No matching documents.");
    return;
  }
  if (action === "page") {
    const page = (yield* integrationValue(api.documents.page(requireCollection(), {
      ...clauses,
      ...(after ? { after } : {}),
    })));
    print(page, () =>
      [
        ...page.documents.map((document) => `${describe(document)}\t${JSON.stringify(document.data)}`),
        ...(page.next ? [`next\t${page.next}`] : []),
      ].join("\n") || "No matching documents.");
    return;
  }
  if (action === "outbox") {
    // The positional is the topic here: only that topic's messages.
    const page = (yield* integrationValue(api.outbox.read({
      ...(collection === undefined ? {} : { topic: collection }),
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    })));
    print(page, () => [
      ...(page.messages.length === 0
        ? ["No messages."]
        : page.messages.map((message) => `${message.id}\t${message.topic}\t${message.emittedAt}\t${JSON.stringify(message.payload)}`)),
      ...(page.cursor === undefined ? [] : [`cursor\t${page.cursor}`]),
      ...(page.more ? ["more\ttrue"] : []),
    ].join("\n"));
    return;
  }

  if (action === "outbox-emit") {
    // Missing is refused here; anything given goes to the outbox, which says
    // what is wrong with it the same way for every client.
    if (collection === undefined) throw new Error("data outbox-emit requires a topic.");
    const message = (yield* integrationValue(api.outbox.emit({
      topic: collection,
      payload: requireData(),
      ...(documentId === undefined ? {} : { id: documentId }),
      ...keyed,
    })));
    print(message, () => `Emitted ${message.id}`);
    return;
  }

  if (action === "outbox-remove") {
    if (ids === undefined || ids.length === 0) throw new Error("data outbox-remove requires --ids with the messages handled.");
    const result = (yield* integrationValue(api.outbox.remove(ids)));
    print(result, () => `Removed ${result.removed} message${result.removed === 1 ? "" : "s"}.`);
    return;
  }

  if (action === "write") {
    if (!Array.isArray(operations)) {
      throw new Error("data write requires --operations with a JSON list of changes.");
    }
    if (emit !== undefined && !Array.isArray(emit)) throw new Error("--emit requires a JSON list of messages.");
    const written = (yield* integrationValue(api.documents.write({
      ...keyed,
      operations: operations as Parameters<typeof api.documents.write>[0]["operations"],
      ...(emit === undefined ? {} : { emit: emit as NonNullable<Parameters<typeof api.documents.write>[0]["emit"]> }),
    })));
    print({ written }, () =>
      written.map((entry) =>
        entry._tag === "Deleted"
          ? `Deleted\t${entry.collection}\t${entry.id}`
          : `${entry._tag}\t${entry.document.collection}\t${describe(entry.document)}`,
      ).join("\n") || "Nothing written.");
    return;
  }
  if (action === "kv-get") {
    const entry = (yield* integrationValue(api.kv.get(requireCollection(), requireDocumentId())));
    if (!entry) {
      print({ entry: null }, () => "Key not found.");
      process.exitCode = 1;
      return;
    }
    print({ entry }, () => `${entry.key}\tv${entry.version}\t${JSON.stringify(entry.value)}`);
    return;
  }
  if (action === "kv-set") {
    const entry = (yield* integrationValue(api.kv.set(requireCollection(), requireDocumentId(), requireData(), {
      ...keyed,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    })));
    print({ entry }, () => `Stored ${entry.key}\tv${entry.version}.`);
    return;
  }
  if (action === "kv-delete") {
    const deleted = (yield* integrationValue(api.kv.remove(requireCollection(), requireDocumentId(), {
      ...keyed,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    })));
    print({ deleted }, () => deleted ? "Deleted." : "No such key.");
    if (!deleted) process.exitCode = 1;
    return;
  }
  if (action === "kv-scan") {
    const page = (yield* integrationValue(api.kv.scan(requireCollection(), {
      ...(prefix !== undefined ? { prefix } : {}),
      ...(lower !== undefined ? { lower } : {}),
      ...(upper !== undefined ? { upper } : {}),
      ...(direction !== undefined ? { direction } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(after !== undefined ? { after } : {}),
    })));
    print(page, () => [
      ...page.entries.map((entry) => `${entry.key}\tv${entry.version}\t${JSON.stringify(entry.value)}`),
      ...(page.next ? [`next\t${page.next}`] : []),
    ].join("\n") || "No keys.");
    return;
  }
  if (action === "kv-changes") {
    const page = (yield* integrationValue(api.kv.changes(requireCollection(), {
      ...(limit !== undefined ? { limit } : {}),
      ...(after !== undefined ? { after } : {}),
    })));
    print(page, () => [
      ...(page.changes.length === 0
        ? ["No changes."]
        : page.changes.map((change) => `${change.type}\t${change.key}\tv${change.revision}\t${change.cursor}`)),
      ...(page.cursor === undefined ? [] : [`cursor\t${page.cursor}`]),
      ...(page.more ? ["more\ttrue"] : []),
    ].join("\n"));
    return;
  }
  if (action === "kv-write") {
    if (!Array.isArray(operations)) {
      throw new Error("data kv-write requires --operations with a JSON list of changes.");
    }
    const written = (yield* integrationValue(api.kv.write(requireCollection(), {
      ...keyed,
      operations: operations as Parameters<typeof api.kv.write>[1]["operations"],
    })));
    print({ written }, () => written.map((entry) =>
      "deleted" in entry
        ? `${entry.deleted ? "Deleted" : "Missing"}\t${entry.key}`
        : `Stored\t${entry.key}\tv${entry.version}`,
    ).join("\n"));
    return;
  }
  if (action === "kv-size") {
    const size = (yield* integrationValue(api.kv.size(requireCollection())));
    print({ size }, () => String(size));
    return;
  }
  if (action === "kv-clear") {
    const removed = (yield* integrationValue(api.kv.clear(requireCollection())));
    print({ removed }, () => `Removed ${removed} keys.`);
    return;
  }
  throw new Error(`Unknown data command "${action}". ${usage}`);
}));
  }
