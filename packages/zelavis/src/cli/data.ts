import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis data <collections|create-collection|drop-collection|get|insert|update|delete|query|page|write> --project ID [collection] [id] [--data JSON] [--where JSON] [--order JSON] [--operations JSON] [--limit N] [--after CURSOR] [--mode merge|replace] [--expected-version N] [--idempotency-key KEY] [--url URL] [--token TOKEN] [--json]";

/**
 * `zelavis data` — App data in one App Project, through the JS SDK client, so
 * the CLI cannot drift from `client.data(projectId).*`.
 *
 * There is no `--tenant`: the Tenant comes from whoever the token authenticates
 * as. An operator who needs to read another Tenant's records is doing an
 * operator's job and uses the dashboard or the Project's own database surface.
 */
export async function runDataCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let projectId: string | undefined;
  let data: unknown;
  let where: unknown;
  let orderBy: unknown;
  let operations: unknown;
  let after: string | undefined;
  let mode: string | undefined;
  let idempotencyKey: string | undefined;
  let limit: number | undefined;
  let expectedVersion: number | undefined;
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
      "--idempotency-key",
    ];
    if (!known.includes(flag)) throw new Error(`Unknown data option "${arg}".`);
    const value = separator === -1 ? args[++index] : arg.slice(separator + 1);
    if (value === undefined || value === "") throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--project") projectId = value;
    if (flag === "--after") after = value;
    if (flag === "--idempotency-key") idempotencyKey = value;
    if (flag === "--mode") {
      if (value !== "merge" && value !== "replace") throw new Error("--mode must be merge or replace.");
      mode = value;
    }
    if (flag === "--data") data = parseJson(flag, value);
    if (flag === "--where") where = parseJson(flag, value);
    if (flag === "--order") orderBy = parseJson(flag, value);
    if (flag === "--operations") operations = parseJson(flag, value);
    if (flag === "--limit") {
      limit = Number(value);
      if (!Number.isSafeInteger(limit)) throw new Error("--limit requires an integer.");
    }
    if (flag === "--expected-version") {
      expectedVersion = Number(value);
      if (!Number.isSafeInteger(expectedVersion)) throw new Error("--expected-version requires an integer.");
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
    const collections = await api.collections.list();
    print({ collections }, () =>
      collections.map((entry) => `${entry.name}\t${entry.surface ?? "database"}`).join("\n")
      || "No collections.");
    return;
  }
  if (action === "create-collection") {
    const created = await api.collections.create({ name: requireCollection() });
    print({ collection: created }, () => `Created collection ${created.name}.`);
    return;
  }
  if (action === "get") {
    const document = await api.documents.get(requireCollection(), requireDocumentId());
    if (!document) {
      print({ document: null }, () => "Document not found.");
      process.exitCode = 1;
      return;
    }
    print({ document }, () => `${describe(document)}\t${JSON.stringify(document.data)}`);
    return;
  }
  if (action === "insert") {
    const document = await api.documents.insert(requireCollection(), {
      ...keyed,
      ...(documentId ? { id: documentId } : {}),
      data: requireData(),
    });
    print({ document }, () => `Inserted ${describe(document)}.`);
    return;
  }
  if (action === "update") {
    const document = await api.documents.update(requireCollection(), requireDocumentId(), {
      ...keyed,
      data: requireData(),
      ...(mode ? { mode: mode as "merge" | "replace" } : {}),
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    print({ document }, () => `Updated ${describe(document)}.`);
    return;
  }
  if (action === "delete") {
    const deleted = await api.documents.delete(requireCollection(), requireDocumentId(), {
      ...keyed,
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    print({ deleted }, () => deleted ? "Deleted." : "No such document.");
    if (!deleted) process.exitCode = 1;
    return;
  }
  if (action === "query") {
    const documents = await api.documents.query(requireCollection(), clauses);
    print({ documents }, () =>
      documents.map((document) => `${describe(document)}\t${JSON.stringify(document.data)}`).join("\n")
      || "No matching documents.");
    return;
  }
  if (action === "page") {
    const page = await api.documents.page(requireCollection(), {
      ...clauses,
      ...(after ? { after } : {}),
    });
    print(page, () =>
      [
        ...page.documents.map((document) => `${describe(document)}\t${JSON.stringify(document.data)}`),
        ...(page.next ? [`next\t${page.next}`] : []),
      ].join("\n") || "No matching documents.");
    return;
  }
  if (action === "write") {
    if (!Array.isArray(operations)) {
      throw new Error("data write requires --operations with a JSON list of changes.");
    }
    const written = await api.documents.write({
      ...keyed,
      operations: operations as Parameters<typeof api.documents.write>[0]["operations"],
    });
    print({ written }, () =>
      written.map((entry) =>
        entry._tag === "Deleted"
          ? `Deleted\t${entry.collection}\t${entry.id}`
          : `${entry._tag}\t${entry.document.collection}\t${describe(entry.document)}`,
      ).join("\n") || "Nothing written.");
    return;
  }
  throw new Error(`Unknown data command "${action}". ${usage}`);
}
