import type { RecipeManifest } from "../core/recipe/index.js";
import type { ZelavisProjectRecipeDefinition, ZelavisServiceRegistryEntry, ZelavisServiceRegistryStateEntry } from "../service.js";

/** Catalogue identity shared by public transports. Acquisition references stay private. */
export interface PublicServiceRegistryIdentity {
  name: string;
  namespace?: string;
  version?: string;
  kind?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  /** Who maintains it; `zelavis` for what the Zelavis project publishes. Separate from `source`, which is about trust in the registry. */
  maintainer?: string;
  order?: number;
}

/** What a person can choose when creating a Project; archive addresses and entry paths stay in the recipe. */
export interface PublicInstallChoices {
  methods: readonly { id: string; driver: "js" | "oci"; requires: readonly string[] }[];
  software: readonly { version: string }[];
}

export function publicInstallChoices(install: RecipeManifest): PublicInstallChoices {
  return {
    methods: install.methods.map((method) => ({ id: method.id, driver: method.driver, requires: method.requires })),
    software: install.software.map((software) => ({ version: software.version })),
  };
}

/** A recipe's Project metadata for public transports, with the install manifest narrowed to its choices. */
export function publicProjectRecipe(project: ZelavisProjectRecipeDefinition | undefined) {
  if (!project) return undefined;
  const { install, ...rest } = project;
  return { ...rest, ...(install ? { install: publicInstallChoices(install) } : {}) };
}

/** Administrative diagnostics only; never include this shape in public discovery. */
export interface ServiceSourceDiagnostic extends PublicServiceRegistryIdentity {
  specifier?: string;
}

export function publicServiceRegistryIdentity<TContext>(
  entry: Readonly<ZelavisServiceRegistryEntry<TContext>> | Readonly<ZelavisServiceRegistryStateEntry>,
): PublicServiceRegistryIdentity {
  const service = "service" in entry ? entry.service : undefined;
  return {
    name: "service" in entry ? entry.service.name : entry.name,
    namespace: service?.namespace,
    version: service?.version,
    kind: service?.kind,
    status: entry.status ?? "available",
    source: entry.source,
    ...(entry.source === "official" || ("maintainer" in entry && entry.maintainer)
      ? { maintainer: ("maintainer" in entry && entry.maintainer) || "zelavis" }
      : {}),
    order: entry.order,
  };
}
