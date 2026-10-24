import { readFile, writeFile } from "node:fs/promises";
import { bodyFlag, required, runTable, type CliInput, type CliTable } from "./command-table.js";

const usage =
  "zelavis storage <list|metadata|get|put|delete> --project ID [path|prefix] [--file FILE | --text TEXT] [--output FILE] [--content-type TYPE] [--cache-control VALUE] [--content-disposition VALUE] [--metadata JSON] [--url URL] [--token TOKEN] [--json]";

const files = (input: CliInput) => input.client.storage(required({ ...input, positional: [input.flags.get("--project") ?? ""] }, 0, "storage commands need --project"));
const path = (input: CliInput) => required(input, 0, "A file path");

const table: CliTable = {
  name: "storage",
  usage,
  valued: ["--project", "--file", "--text", "--output", "--content-type", "--cache-control", "--content-disposition", "--metadata"],
  actions: {
    list: {
      run: (input) => files(input).list(input.positional[0]),
      text: (result: { files: readonly { path: string; size?: number; contentType?: string }[] }) =>
        result.files.map((file) => `${file.path}\t${file.size ?? "?"}\t${file.contentType ?? ""}`).join("\n") || "No files.",
    },
    metadata: { run: (input) => files(input).metadata(path(input)) },
    get: {
      run: async (input) => {
        const target = path(input);
        const file = await files(input).read(target);
        const output = input.flags.get("--output");
        const summary = { path: target, contentType: file.contentType, size: file.bytes.byteLength, ...(file.checksum === undefined ? {} : { checksum: file.checksum }) };
        // With an output file the bytes go there untouched; otherwise they travel in the answer, as text when they are text.
        if (output !== undefined) { await writeFile(output, file.bytes); return { ...summary, file: output }; }
        try { return { ...summary, encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(file.bytes) }; }
        catch { return { ...summary, encoding: "base64", content: Buffer.from(file.bytes).toString("base64") }; }
      },
      text: (result: { encoding?: string; content?: string; file?: string; path: string; size: number }) =>
        result.encoding === "utf8" ? (result.content ?? "") : `${result.path}: ${result.size} bytes${result.file ? ` written to ${result.file}` : " (binary; use --output FILE or --json)"}`,
    },
    put: {
      run: async (input) => {
        const target = path(input);
        const file = input.flags.get("--file"), text = input.flags.get("--text");
        if ((file === undefined) === (text === undefined)) throw new Error("storage put needs exactly one of --file FILE and --text TEXT.");
        const metadata = input.flags.has("--metadata") ? bodyFlag(input, "--metadata", "storage put") as Record<string, string> : undefined;
        const options = {
          ...(input.flags.has("--content-type") ? { contentType: input.flags.get("--content-type")! } : {}),
          ...(input.flags.has("--cache-control") ? { cacheControl: input.flags.get("--cache-control")! } : {}),
          ...(input.flags.has("--content-disposition") ? { contentDisposition: input.flags.get("--content-disposition")! } : {}),
          ...(metadata ? { metadata } : {}),
        };
        return files(input).write(target, file !== undefined ? new Uint8Array(await readFile(file)) : text!, options);
      },
      text: (result: { file: { path: string; size?: number } }) => `Stored ${result.file.path} (${result.file.size ?? "?"} bytes).`,
    },
    delete: { run: (input) => files(input).delete(path(input)), text: (result: { path: string }) => `Deleted ${result.path}.` },
  },
};

/** `zelavis storage` — the files of an App Project, through the SDK client, so the CLI cannot drift from `client.storage(projectId)`. */
export function runStorageCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
