import { readFile, writeFile } from "node:fs/promises";
import { Effect } from "effect";
import { evaluate, integration, present } from "../core/runtime/effect-boundary.js";
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
      run: (input) => present(Effect.gen(function* () {
        const target = yield* evaluate(() => path(input));
        const file = yield* integration(() => files(input).read(target));
        const output = input.flags.get("--output");
        const summary = { path: target, contentType: file.contentType, size: file.bytes.byteLength, ...(file.checksum === undefined ? {} : { checksum: file.checksum }) };
        // With an output file the bytes go there untouched; otherwise they travel in the answer, as text when they are text.
        if (output !== undefined) {
          yield* integration(() => writeFile(output, file.bytes));
          return { ...summary, file: output };
        }
        const text = yield* Effect.try({ try: () => new TextDecoder("utf-8", { fatal: true }).decode(file.bytes), catch: () => undefined }).pipe(Effect.orElseSucceed(() => undefined));
        return text === undefined
          ? { ...summary, encoding: "base64", content: Buffer.from(file.bytes).toString("base64") }
          : { ...summary, encoding: "utf8", content: text };
      })),
      text: (result: { encoding?: string; content?: string; file?: string; path: string; size: number }) =>
        result.encoding === "utf8" ? (result.content ?? "") : `${result.path}: ${result.size} bytes${result.file ? ` written to ${result.file}` : " (binary; use --output FILE or --json)"}`,
    },
    put: {
      run: (input) => present(Effect.gen(function* () {
        const target = yield* evaluate(() => path(input));
        const file = input.flags.get("--file"), text = input.flags.get("--text");
        if ((file === undefined) === (text === undefined)) return yield* evaluate(() => { throw new Error("storage put needs exactly one of --file FILE and --text TEXT."); });
        const metadata = input.flags.has("--metadata") ? yield* evaluate(() => bodyFlag<Record<string, string>>(input, "--metadata", "storage put")) : undefined;
        const options = {
          ...(input.flags.has("--content-type") ? { contentType: input.flags.get("--content-type")! } : {}),
          ...(input.flags.has("--cache-control") ? { cacheControl: input.flags.get("--cache-control")! } : {}),
          ...(input.flags.has("--content-disposition") ? { contentDisposition: input.flags.get("--content-disposition")! } : {}),
          ...(metadata ? { metadata } : {}),
        };
        const body = file !== undefined ? new Uint8Array(yield* integration(() => readFile(file))) : text!;
        return yield* integration(() => files(input).write(target, body, options));
      })),
      text: (result: { file: { path: string; size?: number } }) => `Stored ${result.file.path} (${result.file.size ?? "?"} bytes).`,
    },
    delete: { run: (input) => files(input).delete(path(input)), text: (result: { path: string }) => `Deleted ${result.path}.` },
  },
};

/** `zelavis storage` — the files of an App Project, through the SDK client, so the CLI cannot drift from `client.storage(projectId)`. */
export function runStorageCommand(args: readonly string[]): Promise<void> {
  return runTable(table, args);
}
