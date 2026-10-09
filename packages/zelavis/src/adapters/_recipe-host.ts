import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, createWriteStream, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Effect, Result } from "effect";
import { integration, type IntegrationFailure } from "../core/runtime/effect-boundary.js";
import { RecipeError, type RecipeHostApi, type RecipeSecret } from "../core/recipe/index.js";

/**
 * The Node implementation of `RecipeHost`: everything a recipe phase may do to the machine.
 *
 * What this enforces, and what it does not. Every path is relative to one project directory,
 * and a path that is absolute, climbs with `..`, or crosses a symlink is refused, so a recipe
 * cannot read or write outside its project through this API. Commands run only from a table of
 * absolute executables the host built from the recipe's declared requirements, with a clean
 * environment (none of the host's variables), no shell, a deadline and bounded output, and the
 * whole process group is killed when the deadline passes or the phase is interrupted.
 * Downloads are https only, bounded, and checked against the digest the manifest pinned before a
 * byte is kept. Secrets are generated here, kept in a private directory outside the project and
 * handed to a process or file only by reference; they are removed from anything that comes back.
 *
 * It is not a sandbox. A recipe module is JavaScript that can `import "node:fs"` and bypass this
 * service entirely, which is why phases run in a separate process as the Project's own OS user
 * (see `_recipe-phase-runner.ts`) and why only official, allow-listed packages are accepted.
 */

const MAX_PATH_BYTES = 1024;
const MAX_READ_BYTES = 1024 * 1024;
const MAX_WRITE_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_ARGS = 128;
const MAX_ARG_BYTES = 8192;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_REDIRECTS = 3;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_PROGRESS_BYTES = 500;
const SECRET_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** The host's own tar, not a recipe's: unpacking is a service of the host, not a declared requirement. */
export const TAR_CANDIDATES = ["/usr/bin/tar", "/bin/tar"] as const;

export interface RecipeHostOptions {
  /** The project directory every path is relative to. Must exist. */
  readonly root: string;
  /** Where generated secrets live. Outside `root`, so no path can reach them. */
  readonly secretsDirectory: string;
  /** Requirement name to absolute executable, built by the host from the recipe's `requires`. */
  readonly commands: Readonly<Record<string, string>>;
  readonly progress?: (input: { readonly phase: string; readonly message: string }) => void;
  /** For tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const fail = (operation: string, message: string) => new RecipeError({ operation, message });

/** Fails with a RecipeError whose text names no host path. */
const attempt = <A>(operation: string, message: string, run: (signal: AbortSignal) => A | PromiseLike<A>, options?: { readonly interruptible?: boolean }) =>
  integration(run, options).pipe(
    Effect.mapError((failure: IntegrationFailure) =>
      failure.cause instanceof RecipeError ? failure.cause : fail(operation, message)),
  );

/** `lstat`, or nothing when the path does not exist; any other failure is reported. */
const lstatIfPresent = (operation: string, path: string) =>
  integration(() => lstat(path)).pipe(
    Effect.map((stats): Stats | undefined => stats),
    Effect.catch((failure) => (failure.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? Effect.succeed(undefined)
      : Effect.fail(fail(operation, "The path could not be inspected."))),
  );

const refuse = (operation: string, message: string) => Effect.fail(fail(operation, message));

function checkRelative(operation: string, path: unknown): Effect.Effect<readonly string[], RecipeError> {
  if (typeof path !== "string" || path.length === 0 || Buffer.byteLength(path) > MAX_PATH_BYTES || path.includes("\0") || path.includes("\\")) {
    return refuse(operation, "The path is empty, too long or has characters that are not allowed.");
  }
  if (path.startsWith("/")) return refuse(operation, "The path must be relative to the project.");
  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0) return refuse(operation, "The path names the project directory itself.");
  if (segments.includes("..")) return refuse(operation, "The path leaves the project.");
  return Effect.succeed(segments);
}

export function createRecipeHost(options: RecipeHostOptions): RecipeHostApi {
  const root = resolve(options.root);
  const secretsDirectory = resolve(options.secretsDirectory);
  const fetchImpl = options.fetch ?? fetch;
  /** Secret values this host has handed out, to remove from anything it returns. */
  const known = new Map<string, string>();

  const insideRoot = (candidate: string) => candidate === root || candidate.startsWith(root + sep);

  /**
   * The absolute path for a relative one, after refusing any existing symlink along it. A path
   * that does not exist yet is fine: its parents are checked as far as they exist.
   */
  const locate = (operation: string, path: unknown): Effect.Effect<string, RecipeError> =>
    Effect.gen(function* () {
      const segments = yield* checkRelative(operation, path);
      let current = root;
      for (const segment of segments) {
        current = join(current, segment);
        const exists = yield* lstatIfPresent(operation, current);
        if (exists === undefined) break;
        if (exists.isSymbolicLink()) return yield* refuse(operation, "The path crosses a symbolic link.");
      }
      const absolute = join(root, ...segments);
      if (!insideRoot(absolute)) return yield* refuse(operation, "The path leaves the project.");
      return absolute;
    });

  const secretFile = (name: string) => join(secretsDirectory, name);

  const secretValue = (operation: string, name: string) =>
    Effect.gen(function* () {
      if (!SECRET_NAME.test(name)) return yield* refuse(operation, "The secret name is not valid.");
      const cached = known.get(name);
      if (cached !== undefined) return cached;
      const file = secretFile(name);
      const stats = yield* attempt(operation, `The secret "${name}" could not be read; generate it first.`, () => lstat(file));
      if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) return yield* refuse(operation, `The secret "${name}" is not a private file.`);
      const value = yield* attempt(operation, `The secret "${name}" could not be read; generate it first.`, () => readFile(file, "utf8"));
      known.set(name, value);
      return value;
    });

  const reveal = (operation: string, value: string | RecipeSecret) =>
    typeof value === "string" ? Effect.succeed(value) : secretValue(operation, value.secret);

  /** Text and secret references joined into one string. */
  const assemble = (operation: string, content: string | RecipeSecret | readonly (string | RecipeSecret)[]) =>
    Array.isArray(content)
      ? Effect.forEach(content as readonly (string | RecipeSecret)[], (part) => reveal(operation, part)).pipe(Effect.map((parts) => parts.join("")))
      : reveal(operation, content as string | RecipeSecret);
  const carriesSecret = (content: string | RecipeSecret | readonly (string | RecipeSecret)[]) =>
    typeof content === "string" ? false : Array.isArray(content) ? (content as readonly (string | RecipeSecret)[]).some((part) => typeof part !== "string") : true;

  const scrub = (text: string) => {
    let clean = text;
    for (const value of known.values()) if (value.length >= 8) clean = clean.split(value).join("[secret]");
    return clean;
  };

  const spawnTar = (operation: string, args: readonly string[], collect: boolean) =>
    Effect.gen(function* () {
      let tar: string | undefined;
      for (const candidate of TAR_CANDIDATES) {
        const found = yield* Effect.result(integration(() => stat(candidate)));
        if (Result.isSuccess(found) && found.success.isFile()) { tar = candidate; break; }
      }
      if (tar === undefined) return yield* refuse(operation, "The host has no tar to unpack with.");
      return yield* execute(operation, tar, args, { PATH: "/usr/bin:/bin" }, 10 * 60_000, collect ? MAX_OUTPUT_BYTES * 16 : MAX_OUTPUT_BYTES);
    });

  const execute = (operation: string, executable: string, args: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number, maxOutput: number) =>
    Effect.callback<{ code: number; stdout: string; stderr: string; truncated: boolean }, RecipeError>((resume) => {
      const child = spawn(executable, [...args], { cwd: root, env: { ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true, shell: false });
      let stdout = "";
      let stderr = "";
      let truncated = false;
      let settled = false;
      const take = (current: string, chunk: Buffer) => {
        if (current.length + chunk.length > maxOutput) { truncated = true; return current + chunk.subarray(0, Math.max(0, maxOutput - current.length)).toString("utf8"); }
        return current + chunk.toString("utf8");
      };
      const killGroup = () => {
        if (child.pid === undefined) return;
        // The whole group: a recipe's command may start children of its own.
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killGroup();
        resume(Effect.fail(fail(operation, `The command did not finish within ${timeoutMs} ms and was stopped.`)));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout = take(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = take(stderr, chunk); });
      child.once("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resume(Effect.fail(fail(operation, "The command could not be started.")));
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // A command that leaves children behind after it exits does not keep the phase alive.
        killGroup();
        resume(Effect.succeed({ code: code ?? (signal ? 128 : 1), stdout, stderr, truncated }));
      });
      return Effect.sync(() => { if (!settled) { settled = true; clearTimeout(timer); killGroup(); } });
    });

  /** Nothing but plain files and directories may be left in an unpacked archive, and not too many or too large. */
  const walkExtracted = (operation: string, directory: string) =>
    Effect.gen(function* () {
      let entries = 0;
      let bytes = 0;
      const visit = (current: string): Effect.Effect<void, RecipeError> => Effect.gen(function* () {
        const names = yield* attempt(operation, "The archive's contents could not be checked.", () => readdir(current));
        for (const name of names) {
          const path = join(current, name);
          const stats = yield* attempt(operation, "The archive's contents could not be checked.", () => lstat(path));
          entries += 1;
          if (entries > MAX_ARCHIVE_ENTRIES) return yield* refuse(operation, "The archive holds too many entries.");
          if (stats.isDirectory()) { yield* visit(path); continue; }
          if (!stats.isFile() || stats.nlink > 1) return yield* refuse(operation, "The archive holds a link or a special file, which is not allowed.");
          bytes += stats.size;
          if (bytes > MAX_EXTRACTED_BYTES) return yield* refuse(operation, "The archive unpacks to more than is allowed.");
        }
      });
      yield* visit(directory);
    });

  /** Keeps the bytes, counts them and hashes them as they pass; refuses to pass more than allowed. */
  const measure = (limit: number) => {
    const hash = createHash("sha256");
    let received = 0;
    const stream = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        received += chunk.length;
        if (received > limit) { done(fail("download", "The download is larger than the manifest allows.")); return; }
        hash.update(chunk);
        done(null, chunk);
      },
    });
    return { stream, digest: () => hash.digest() };
  };

  const api: RecipeHostApi = {
    files: {
      read: (path) => Effect.gen(function* () {
        const file = yield* locate("files.read", path);
        const stats = yield* attempt("files.read", "The file could not be read.", () => lstat(file));
        if (!stats.isFile()) return yield* refuse("files.read", "The path is not a regular file.");
        if (stats.size > MAX_READ_BYTES) return yield* refuse("files.read", "The file is larger than a recipe may read.");
        return yield* attempt("files.read", "The file could not be read.", () => readFile(file, "utf8"));
      }),
      write: (path, content) => Effect.gen(function* () {
        const file = yield* locate("files.write", path);
        const text = yield* assemble("files.write", content);
        if (Buffer.byteLength(text) > MAX_WRITE_BYTES) return yield* refuse("files.write", "The content is larger than a recipe may write.");
        // A file carrying a secret is private; anything else keeps ordinary permissions.
        const mode = carriesSecret(content) ? 0o600 : 0o644;
        const failed = "The file could not be written.";
        yield* attempt("files.write", failed, () => mkdir(dirname(file), { recursive: true }));
        const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
        // O_NOFOLLOW: never write through a link planted between the check and the write.
        const handle = yield* attempt("files.write", failed, () => open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode));
        yield* attempt("files.write", failed, () => handle.writeFile(text)).pipe(
          Effect.ensuring(attempt("files.write", failed, () => handle.close()).pipe(Effect.orElseSucceed(() => undefined))),
          Effect.onError(() => attempt("files.write", failed, () => rm(temporary, { force: true })).pipe(Effect.orElseSucceed(() => undefined))),
        );
        yield* attempt("files.write", failed, () => chmod(temporary, mode));
        yield* attempt("files.write", failed, () => rename(temporary, file));
      }),
      exists: (path) => Effect.gen(function* () {
        const file = yield* locate("files.exists", path);
        return (yield* lstatIfPresent("files.exists", file)) !== undefined;
      }),
      mkdir: (path) => Effect.gen(function* () {
        const directory = yield* locate("files.mkdir", path);
        yield* attempt("files.mkdir", "The directory could not be created.", () => mkdir(directory, { recursive: true }));
      }),
      remove: (path) => Effect.gen(function* () {
        const target = yield* locate("files.remove", path);
        yield* attempt("files.remove", "The path could not be removed.", () => rm(target, { recursive: true, force: true }));
      }),
    },

    download: (input) => Effect.gen(function* () {
      let url: URL;
      try { url = new URL(input.url); } catch { return yield* refuse("download", "The download address is not a URL."); }
      if (url.protocol !== "https:" || url.username || url.password) return yield* refuse("download", "Downloads must be https addresses without credentials.");
      if (typeof input.sha256 !== "string" || !SHA256.test(input.sha256)) return yield* refuse("download", "A download needs the SHA-256 it must match.");
      if (!Number.isInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 1024 * 1024 * 1024) return yield* refuse("download", "The size limit is not valid.");
      const destination = yield* locate("download", input.destination);
      const failed = "The download failed.";
      const limit = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      let current = url;
      let response: Response | undefined;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const target = current;
        response = yield* attempt("download", failed, (signal) => fetchImpl(target, { redirect: "manual", signal: AbortSignal.any([signal, limit]) }), { interruptible: true });
        if (response.status < 300 || response.status > 399) break;
        const next = response.headers.get("location");
        if (!next || hop === MAX_REDIRECTS) return yield* refuse("download", "The download redirected too many times.");
        const followed = yield* Effect.try({ try: () => new URL(next, current), catch: () => fail("download", "The download redirected to something that is not an address.") });
        if (followed.protocol !== "https:" || followed.username || followed.password) return yield* refuse("download", "The download redirected to an address that is not https.");
        current = followed;
      }
      if (!response || !response.ok || !response.body) return yield* refuse("download", `The server answered ${response?.status ?? "nothing"}.`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > input.maxBytes) return yield* refuse("download", "The download is larger than the manifest allows.");
      const body = response.body as unknown as NodeJS.ReadableStream;
      yield* attempt("download", failed, () => mkdir(dirname(destination), { recursive: true }));
      const partial = `${destination}.${randomBytes(6).toString("hex")}.part`;
      const measured = measure(input.maxBytes);
      yield* Effect.gen(function* () {
        yield* attempt("download", failed, (signal) => pipeline(
          body, measured.stream, createWriteStream(partial, { flags: "wx", mode: 0o644 }), { signal: AbortSignal.any([signal, limit]) },
        ), { interruptible: true });
        const actual = measured.digest();
        const expected = Buffer.from(input.sha256, "hex");
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
          return yield* refuse("download", "The download does not match the SHA-256 the manifest pinned; it was discarded.");
        }
        yield* attempt("download", failed, () => rename(partial, destination));
      }).pipe(Effect.onError(() => attempt("download", failed, () => rm(partial, { force: true })).pipe(Effect.orElseSucceed(() => undefined))));
    }),

    extract: (archive, destination, extractOptions) => Effect.gen(function* () {
      const source = yield* locate("extract", archive);
      const target = yield* locate("extract", destination);
      if (!/\.(?:tar\.gz|tgz)$/.test(source)) return yield* refuse("extract", "Only .tar.gz archives are supported.");
      const present = yield* attempt("extract", "The destination could not be inspected.", () => lstat(target).then(() => true, () => false));
      if (present) return yield* refuse("extract", "The destination already exists; remove it first.");
      const strip = extractOptions?.stripTopLevel === true;
      // Names first, so nothing is unpacked that points outside or has no single root to strip.
      const listing = yield* spawnTar("extract", ["-tzf", source], true);
      if (listing.code !== 0 || listing.truncated) return yield* refuse("extract", "The archive could not be read.");
      const names = listing.stdout.split("\n").filter((line) => line.length > 0);
      if (names.length === 0 || names.length > MAX_ARCHIVE_ENTRIES) return yield* refuse("extract", "The archive is empty or holds too many entries.");
      for (const name of names) {
        if (name.startsWith("/") || name.split("/").includes("..") || name.includes("\0")) return yield* refuse("extract", "The archive names a path outside its destination.");
      }
      if (strip && new Set(names.map((name) => name.replace(/^\.\//, "").split("/")[0])).size !== 1) {
        return yield* refuse("extract", "The archive does not have exactly one top-level directory.");
      }
      const staging = `${target}.${randomBytes(6).toString("hex")}.extracting`;
      yield* attempt("extract", "The destination could not be prepared.", () => mkdir(staging, { recursive: true }));
      const cleanup = attempt("extract", "Cleanup failed.", () => rm(staging, { recursive: true, force: true }));
      const outcome = yield* Effect.gen(function* () {
        const unpacked = yield* spawnTar("extract", ["-xzf", source, "-C", staging, "--no-same-owner", ...(strip ? ["--strip-components=1"] : [])], false);
        if (unpacked.code !== 0) return yield* refuse("extract", "The archive could not be unpacked.");
        // Whatever tar did, nothing but plain files and directories is kept.
        yield* walkExtracted("extract", staging);
        yield* attempt("extract", "The unpacked files could not be moved into place.", () => rename(staging, target));
      }).pipe(Effect.onError(() => cleanup.pipe(Effect.orElseSucceed(() => undefined))));
      return outcome;
    }),

    run: (input) => Effect.gen(function* () {
      if (typeof input.command !== "string" || !COMMAND_NAME.test(input.command)) return yield* refuse("run", "The command name is not valid.");
      const executable = options.commands[input.command];
      if (executable === undefined) return yield* refuse("run", `"${input.command}" is not an executable this recipe declared.`);
      if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > MAX_TIMEOUT_MS) return yield* refuse("run", "The time limit is not valid.");
      if (input.args.length > MAX_ARGS) return yield* refuse("run", "There are too many arguments.");
      const args: string[] = [];
      for (const argument of input.args) {
        const value = yield* reveal("run", argument);
        if (Buffer.byteLength(value) > MAX_ARG_BYTES || value.includes("\0")) return yield* refuse("run", "An argument is too long or has characters that are not allowed.");
        args.push(value);
      }
      // The host's variables never reach the command; it gets a fixed minimum and what the recipe names.
      // Tools find their siblings: the directories of the declared executables come first.
      const toolPath = [...new Set([...Object.values(options.commands).map((path) => dirname(path)), ...(process.env.PATH ?? "/usr/bin:/bin").split(":")])].join(":");
      const env: Record<string, string> = { PATH: toolPath, HOME: root, LANG: "C.UTF-8", TMPDIR: join(root, ".tmp") };
      for (const [name, value] of Object.entries(input.env ?? {})) {
        if (!ENV_NAME.test(name)) return yield* refuse("run", `"${name}" is not a valid variable name.`);
        const text = yield* reveal("run", value);
        if (text.includes("\0")) return yield* refuse("run", "A variable has characters that are not allowed.");
        env[name] = text;
      }
      const stats = yield* attempt("run", "The executable could not be inspected.", () => stat(executable).then((value) => value, () => undefined));
      if (stats === undefined || !stats.isFile() || (stats.mode & 0o111) === 0) return yield* refuse("run", `"${input.command}" is not installed on this host.`);
      yield* attempt("run", "The scratch directory could not be prepared.", () => mkdir(join(root, ".tmp"), { recursive: true, mode: 0o700 }));
      const result = yield* execute("run", executable, args, env, input.timeoutMs, MAX_OUTPUT_BYTES);
      return { code: result.code, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
    }),

    secret: (name) => Effect.gen(function* () {
      if (typeof name !== "string" || !SECRET_NAME.test(name)) return yield* refuse("secret", "The secret name is not valid.");
      const failed = "The secret could not be created.";
      yield* attempt("secret", failed, () => mkdir(secretsDirectory, { recursive: true, mode: 0o700 }));
      yield* attempt("secret", failed, () => chmod(secretsDirectory, 0o700));
      const opened = yield* Effect.result(integration(() => open(secretFile(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)));
      if (Result.isFailure(opened)) {
        // Generated once and kept: asking again for the same name is how a phase resumes.
        if ((opened.failure.cause as NodeJS.ErrnoException | undefined)?.code === "EEXIST") return { secret: name };
        return yield* refuse("secret", failed);
      }
      const handle = opened.success;
      yield* attempt("secret", failed, () => handle.writeFile(randomBytes(32).toString("base64url"))).pipe(
        Effect.ensuring(attempt("secret", failed, () => handle.close()).pipe(Effect.orElseSucceed(() => undefined))),
      );
      return { secret: name };
    }),

    progress: (input) => Effect.gen(function* () {
      if (typeof input.phase !== "string" || typeof input.message !== "string") return yield* refuse("progress", "A progress record needs a phase and a message.");
      options.progress?.({ phase: input.phase.slice(0, 64), message: scrub(input.message).slice(0, MAX_PROGRESS_BYTES) });
    }),
  };
  return api;
}
