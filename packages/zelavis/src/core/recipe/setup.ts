import { SETUP_TOKEN, type RecipeManifest } from "./manifest.js";

/**
 * Values a person needs to finish an application's own setup, made from a recipe's `setup` templates.
 * Pure: the caller supplies what the Platform knows about the Project and the secrets it was allowed to read.
 */

export interface ProjectSetupValue {
  readonly id: string;
  readonly label: string;
  /** Whether the value contains a secret: it is shown only when asked for by name by someone allowed to. */
  readonly secret: boolean;
  readonly value?: string;
}

export interface SetupSource {
  readonly ports: Readonly<Record<string, number>>;
  /** Declared directories at the place the Project has them now. */
  readonly directories: Readonly<Record<string, string>>;
  readonly root: string;
  readonly sockets: string;
  readonly user: string;
}

type SetupEntry = NonNullable<RecipeManifest["setup"]>[number];

/** The secrets a template names. */
export const setupSecrets = (entry: SetupEntry): readonly string[] =>
  [...entry.value.matchAll(SETUP_TOKEN)].flatMap((match) => match[1] === "secret" && match[2] ? [match[2]] : []);

/** Fills one template. A token this source cannot answer is an error: nothing is guessed. */
export function fillSetupValue(entry: SetupEntry, source: SetupSource, secrets: Readonly<Record<string, string>>): string {
  return entry.value.replace(SETUP_TOKEN, (token, kind: string | undefined, name: string | undefined, plain: string | undefined) => {
    const found = kind === "ports" ? source.ports[name!] !== undefined ? String(source.ports[name!]) : undefined
      : kind === "dir" ? source.directories[name!]
      : kind === "secret" ? secrets[name!]
      : plain === "root" ? source.root : plain === "sockets" ? source.sockets : plain === "user" ? source.user : undefined;
    if (found === undefined) throw new Error(`Setup value "${entry.id}" cannot be filled: ${token} is unknown to this Project.`);
    return found;
  });
}

/** The listing: secret entries carry no value unless `secrets` was supplied for them. */
export function listSetupValues(manifest: Pick<RecipeManifest, "setup">, source: SetupSource, secrets?: Readonly<Record<string, string>>): readonly ProjectSetupValue[] {
  return (manifest.setup ?? []).map((entry) => {
    const secret = setupSecrets(entry).length > 0;
    const base = { id: entry.id, label: entry.label, secret } as const;
    return secret && secrets === undefined ? base : { ...base, value: fillSetupValue(entry, source, secrets ?? {}) };
  });
}
