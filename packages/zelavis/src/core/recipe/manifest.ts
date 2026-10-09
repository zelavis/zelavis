import { Schema } from "effect";

const Name = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/),
);
const Version = Schema.String.check(
  Schema.isPattern(/^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/),
  Schema.isMaxLength(64),
);
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const Entry = Schema.String.check(
  Schema.isPattern(/^\.\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:mjs|js)$/),
  Schema.isMaxLength(256),
);
const Requirements = Schema.Array(Name).check(Schema.isMaxLength(32));
const Port = Schema.Struct({ name: Name, protocol: Schema.Literals(["http", "tcp", "udp"]) });
const RelativePath = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)*$/),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => !value.split("/").some((part) => part === "." || part === "..")),
);
const JsonKey = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/));

/**
 * How an install made by an earlier version of this recipe becomes one of this version's, by
 * moving folders and carrying a few values over. Nothing in the application's files or database is
 * read, rewritten or converted: the Platform renames the folders, writes the carried values
 * where this recipe keeps them, and the recipe's own install resumes over what is there.
 */
const Adoption = Schema.Struct({
  /** A JSON file in the earlier layout's directory (the Project's `.zelavis`); its presence marks that layout. */
  state: RelativePath,
  /** Earlier path (below that directory) to the path it takes below the recipe's root. */
  move: Schema.Record(RelativePath, RelativePath).check(Schema.makeFilter((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 16)),
  /** Port name to the key of `state` that holds its number. */
  ports: Schema.optional(Schema.Record(Name, JsonKey)),
  /** Secret name to the key of `state` that holds its value. */
  secrets: Schema.optional(Schema.Record(Name, JsonKey)),
  /** The key of `state` that holds the socket identity, kept so addresses stay the same. */
  socketId: Schema.optional(JsonKey),
  /** Empty files created below the root once the move is done, for what the recipe records as finished. */
  marks: Schema.optional(Schema.Array(RelativePath).check(Schema.isMaxLength(16))),
  /** Earlier files removed when the upgrade is committed (generated configuration, pid files). */
  discard: Schema.optional(Schema.Array(RelativePath).check(Schema.isMaxLength(32))),
});

const HttpsUrl = Schema.String.check(Schema.isMaxLength(2048), Schema.makeFilter((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch { return false; }
}));

/** The verified package's install metadata, independent of its npm revision. */
export const RecipeManifest = Schema.Struct({
  contract: Schema.Literal(1),
  methods: Schema.Array(Schema.Union([
    Schema.Struct({ id: Name, driver: Schema.Literal("js"), entry: Entry, requires: Requirements }),
    Schema.Struct({
      id: Name,
      driver: Schema.Literal("oci"),
      image: Schema.String.check(
        Schema.isPattern(/^[a-z0-9]+(?:[a-z0-9._:/-]*[a-z0-9])?@sha256:[a-f0-9]{64}$/),
        Schema.isMaxLength(512),
      ),
      requires: Requirements,
    }),
  ])).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  software: Schema.Array(Schema.Struct({
    version: Version,
    archive: HttpsUrl,
    sha256: Digest,
    maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 * 1024 * 1024 })),
  })).check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  ports: Schema.Array(Port).check(Schema.isMaxLength(32)),
  /** Earlier layouts of this recipe that a Project may be upgraded from without moving its data anywhere else. */
  adopt: Schema.optional(Schema.Array(Adoption).check(Schema.isMaxLength(4))),
});

export type RecipeManifest = typeof RecipeManifest.Type;
export type RecipeMethod = RecipeManifest["methods"][number];

export class InvalidRecipeManifest extends Schema.TaggedError<InvalidRecipeManifest>()(
  "InvalidRecipeManifest", { message: Schema.String },
) {}

function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new InvalidRecipeManifest({ message: `Duplicate ${label} in recipe manifest.` });
  }
}

/** Refuse unknown fields, including nested ones; retain an immutable snapshot. */
export function parseRecipeManifest(input: unknown): RecipeManifest {
  try {
    let manifest: RecipeManifest;
    try {
      manifest = Schema.decodeUnknownSync(RecipeManifest)(input, { onExcessProperty: "error" });
    } catch {
      throw new InvalidRecipeManifest({ message: "Recipe manifest does not match contract 1." });
    }
    unique(manifest.methods.map((method) => method.id), "method IDs");
    unique(manifest.software.map((software) => software.version), "software versions");
    unique(manifest.ports.map((port) => port.name), "port names");
    for (const method of manifest.methods) unique(method.requires, "requirements");
    for (const adoption of manifest.adopt ?? []) {
      unique(Object.keys(adoption.move), "adopted sources");
      unique(Object.values(adoption.move), "adopted destinations");
      for (const port of Object.keys(adoption.ports ?? {})) {
        if (!manifest.ports.some((declared) => declared.name === port)) {
          throw new InvalidRecipeManifest({ message: `Adoption names the port "${port}", which the recipe does not declare.` });
        }
      }
    }
    return Object.freeze({
      ...manifest,
      methods: Object.freeze(manifest.methods.map((method) => Object.freeze({
        ...method, requires: Object.freeze([...method.requires]),
      }))),
      software: Object.freeze(manifest.software.map((software) => Object.freeze({ ...software }))),
      ports: Object.freeze(manifest.ports.map((port) => Object.freeze({ ...port }))),
      ...(manifest.adopt ? { adopt: Object.freeze(manifest.adopt.map((adoption) => Object.freeze({
        ...adoption,
        move: Object.freeze({ ...adoption.move }),
        ...(adoption.ports ? { ports: Object.freeze({ ...adoption.ports }) } : {}),
        ...(adoption.secrets ? { secrets: Object.freeze({ ...adoption.secrets }) } : {}),
        ...(adoption.marks ? { marks: Object.freeze([...adoption.marks]) } : {}),
        ...(adoption.discard ? { discard: Object.freeze([...adoption.discard]) } : {}),
      }))) } : {}),
    });
  } catch (cause) {
    if (cause instanceof InvalidRecipeManifest) throw cause;
    throw new InvalidRecipeManifest({ message: `Invalid recipe manifest: ${String(cause)}` });
  }
}

export class RecipeMethodUnavailable extends Schema.TaggedError<RecipeMethodUnavailable>()(
  "RecipeMethodUnavailable", { message: Schema.String },
) {}

/** Selection is for creation only. Persist the returned ID; never reselect at start. */
export function selectRecipeMethod(manifest: RecipeManifest, host: {
  readonly drivers: readonly RecipeMethod["driver"][];
  /** Includes requirements the host can provision through approved operations. */
  readonly requirements: readonly string[];
  readonly method?: string;
}): RecipeMethod {
  const candidates = host.method === undefined
    ? manifest.methods
    : manifest.methods.filter((method) => method.id === host.method);
  for (const method of candidates) {
    if (host.drivers.includes(method.driver) &&
        method.requires.every((requirement) => host.requirements.includes(requirement))) return method;
  }
  throw new RecipeMethodUnavailable({
    message: host.method === undefined
      ? "This host cannot satisfy any declared recipe method."
      : `The requested recipe method "${host.method}" is unavailable; no alternative was selected.`,
  });
}

export class RecipeSoftwareUnavailable extends Schema.TaggedError<RecipeSoftwareUnavailable>()(
  "RecipeSoftwareUnavailable", { message: Schema.String },
) {}

const versionParts = (version: string) => version.split(".").map(Number);

/** Orders `x.y` and `x.y.z` versions; the newest sorts last. */
export function compareSoftwareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The software version a new Project installs: the one asked for, which must be offered, or
 * the newest. Like method selection this happens once, at creation; the result is locked.
 */
export function selectRecipeSoftware(manifest: RecipeManifest, requested?: string): RecipeManifest["software"][number] {
  if (requested !== undefined) {
    const found = manifest.software.find((software) => software.version === requested);
    if (!found) {
      throw new RecipeSoftwareUnavailable({
        message: `Software version "${requested}" is not offered by this recipe (${manifest.software.map((software) => software.version).join(", ")}).`,
      });
    }
    return found;
  }
  return [...manifest.software].sort((a, b) => compareSoftwareVersions(a.version, b.version)).at(-1)!;
}
