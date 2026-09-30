import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZelavisProjectDescriptor, ZelavisProjectRecipeLock, ZelavisProjectRuntimeDriver } from "../project.js";
import { ZelavisProjectRuntimeError } from "../project.js";
import {
  createNodeProcessProjectRuntime,
  type NodeProcessProjectRuntimeOptions,
} from "./_node-project-runtime.js";
import {
  createServerFrontendProjectRuntime,
  type ServerFrontendProjectRuntimeOptions,
} from "./_server-frontend-project-runtime.js";
import { createLocalAgentProcessRunner } from "./_agent-process-runner.js";
import type { ZelavisAgentProcessRunner } from "../core/agent/process-command.js";
import { resolveBundledServiceDirectory, linkPlatformPackage } from "./_local-runtime.js";
import {
  RECIPE_ARTIFACT_DIRECTORY,
  digestArtifactDirectory,
  materializeRecipeArtifact,
} from "./_recipe-artifact.js";

/**
 * Where a recipe that provides its own runtime comes from, and whether this host
 * lets it.
 */
export interface RecipeRuntimeSources {
  /** Where an installed or checked-out recipe package lies. Bundled ones are found without it. */
  packageDirectory?(name: string): Promise<string | undefined> | string | undefined;
  /**
   * Whether a recipe may provide the runtime its Projects run under. A recipe
   * runtime is host code with the Platform's authority, so this is a decision
   * the host makes, never something a package claims for itself.
   */
  trusted(name: string): Promise<boolean> | boolean;
}

export interface LocalProjectRuntimeOptions extends NodeProcessProjectRuntimeOptions {
  /**
   * Runs `server` frontends. Omit it and a frontend Project cannot start,
   * rather than silently falling through to the Zelavis runner and failing in
   * a way that looks like a broken frontend.
   */
  serverFrontend?: Omit<ServerFrontendProjectRuntimeOptions, "directory">;
  /**
   * Recipes that provide their own runtime (their `package.json` declares
   * `zelavis.project.runtime`). Without it no recipe can, and a Project of one
   * fails to prepare with that reason.
   */
  recipeRuntimes?: RecipeRuntimeSources;
  /** Options for a recipe's runtime, by recipe name. */
  recipeRuntimeOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * Agent that executes every Project process on this host.
   *
   * Defaults to running them in this process. Point it at a separately
   * supervised Agent and the drivers are unchanged — that is what putting them
   * behind the contract bought.
   */
  agent?: ZelavisAgentProcessRunner;
}

/** Project kind used for a Project-owned server frontend. */
const SERVER_FRONTEND_KIND = "frontend";

function frozenRecipeDirectory(projectsDirectory: string, projectId: string): string {
  return join(projectsDirectory, projectId, ".zelavis", RECIPE_ARTIFACT_DIRECTORY, "package");
}

/** The runtime module a recipe package declares, or undefined when it has none. */
async function declaredRuntimeEntry(packageDirectory: string): Promise<string | undefined> {
  let manifest: { zelavis?: { project?: { runtime?: unknown } } };
  try {
    manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
  const entry = manifest.zelavis?.project?.runtime;
  if (entry === undefined) return undefined;
  if (typeof entry !== "string" || !entry.startsWith("./") || entry.split("/").includes("..")) {
    throw new ZelavisProjectRuntimeError(
      "A recipe's zelavis.project.runtime must be a path inside its own package, such as ./dist/runtime.js.",
    );
  }
  return entry;
}

/** Routes Project recipes to native drivers while preserving one Platform lifecycle boundary. */
export function createLocalProjectRuntime(options: LocalProjectRuntimeOptions): ZelavisProjectRuntimeDriver {
  const directory = resolve(options.directory);
  // One Agent for every driver rather than one each. They share a host, so
  // they share the record of what is running on it — separate runners would
  // each sweep only their own leftovers, and a Project that changed recipe
  // would leave one behind that nothing owns. It is also the single place to
  // swap in an Agent that runs elsewhere.
  const agent =
    options.agent ??
    createLocalAgentProcessRunner({
      stateDirectory: join(directory, ".agent-processes"),
    });
  const node = createNodeProcessProjectRuntime({ ...options, agent });
  const serverFrontend = options.serverFrontend
    ? createServerFrontendProjectRuntime({
        directory,
        ...options.serverFrontend,
        agent,
      })
    : undefined;

  // Recipe runtimes are loaded from the copy frozen inside each Project and
  // shared by every Project frozen to the same digest.
  const recipeDrivers = new Map<string, ZelavisProjectRuntimeDriver>();
  const driverOfProject = new Map<string, ZelavisProjectRuntimeDriver>();
  const verified = new Set<string>();

  const selectFrontend = (): ZelavisProjectRuntimeDriver => {
    if (!serverFrontend) {
      throw new ZelavisProjectRuntimeError(
        "This host is not configured to run server frontends.",
      );
    }
    return serverFrontend;
  };

  const assertNative = (runtimeKind: unknown) => {
    // An absent kind is refused like a foreign one: this driver executes only
    // an explicit native assignment and never infers one.
    if (runtimeKind !== "native") {
      throw new ZelavisProjectRuntimeError(
        runtimeKind === undefined
          ? "The local Project runtime requires an explicit native runtime kind."
          : `The local Project runtime cannot execute the "${String(runtimeKind)}" runtime kind.`,
      );
    }
  };

  async function assertTrusted(name: string): Promise<void> {
    if (!(await options.recipeRuntimes?.trusted(name))) {
      throw new ZelavisProjectRuntimeError(
        `Project recipe "${name}" provides its own runtime, and this host has not enabled that. ` +
          "Only recipes an operator trusts (for example an allow-listed official one) may.",
      );
    }
  }

  /** Loads a recipe's runtime from the frozen copy, once per digest. */
  async function loadRecipeDriver(
    projectId: string,
    recipe: Pick<ZelavisProjectRecipeLock, "name">,
    digest: string,
    entry: string,
  ): Promise<ZelavisProjectRuntimeDriver> {
    await assertTrusted(recipe.name);
    const cached = recipeDrivers.get(digest);
    if (cached) {
      driverOfProject.set(projectId, cached);
      return cached;
    }
    const frozen = frozenRecipeDirectory(directory, projectId);
    const key = `${projectId}:${digest}`;
    if (!verified.has(key) && (await digestArtifactDirectory(frozen)) !== digest) {
      throw new ZelavisProjectRuntimeError(
        `Project recipe "${recipe.name}" does not match its locked digest; refusing to run modified code.`,
      );
    }
    verified.add(key);
    // Lets the frozen package resolve `zelavis/*` against the Platform running it.
    await linkPlatformPackage(join(directory, projectId, ".zelavis", RECIPE_ARTIFACT_DIRECTORY));
    const module = (await import(pathToFileURL(join(frozen, entry)).href)) as {
      createProjectRuntime?: (context: unknown) => ZelavisProjectRuntimeDriver;
    };
    if (typeof module.createProjectRuntime !== "function") {
      throw new ZelavisProjectRuntimeError(
        `Project recipe "${recipe.name}" declares a runtime but does not export createProjectRuntime.`,
      );
    }
    const driver = module.createProjectRuntime({
      directory,
      agent,
      options: options.recipeRuntimeOptions?.[recipe.name] ?? {},
    });
    recipeDrivers.set(digest, driver);
    driverOfProject.set(projectId, driver);
    return driver;
  }

  /**
   * The runtime a recipe provides for a Project, or undefined when it provides
   * none. At `prepare` an unfrozen recipe is frozen first (its runtime then
   * runs from the frozen copy, so a Platform update cannot change it); any other
   * time it must already be frozen.
   */
  async function recipeDriver(
    projectId: string,
    recipe: Pick<ZelavisProjectRecipeLock, "name"> & { artifact?: { digest: string } },
    mode: "prepare" | "use",
  ): Promise<{ driver: ZelavisProjectRuntimeDriver; digest: string } | undefined> {
    const frozen = frozenRecipeDirectory(directory, projectId);
    if (existsSync(frozen)) {
      const entry = await declaredRuntimeEntry(frozen);
      if (!entry) return undefined;
      const digest = recipe.artifact?.digest ?? (await digestArtifactDirectory(frozen));
      return { driver: await loadRecipeDriver(projectId, recipe, digest, entry), digest };
    }
    if (mode === "use") return undefined;
    const source =
      (await options.recipeRuntimes?.packageDirectory?.(recipe.name)) ??
      resolveBundledServiceDirectory(recipe.name);
    if (!source) return undefined;
    const entry = await declaredRuntimeEntry(source);
    if (!entry) return undefined;
    await assertTrusted(recipe.name);
    const { digest } = await materializeRecipeArtifact(source, join(directory, projectId, ".zelavis"));
    return { driver: await loadRecipeDriver(projectId, recipe, digest, entry), digest };
  }

  const forDescriptor = (project: Readonly<ZelavisProjectDescriptor>) => {
    assertNative(project.runtimeKind);
    if (project.kind === SERVER_FRONTEND_KIND) return selectFrontend();
    // Loaded by an earlier prepare or by `adopt`; until then the Zelavis
    // runner's description stands in for it.
    return driverOfProject.get(project.id) ?? node;
  };
  const forProjectId = async (projectId: string) => {
    const record = JSON.parse(await readFile(join(directory, projectId, "project.json"), "utf8")) as {
      recipe?: { name?: unknown; artifact?: { digest?: unknown } };
      kind?: unknown;
      runtimeKind?: unknown;
    };
    assertNative(record.runtimeKind);
    if (record.kind === SERVER_FRONTEND_KIND) return selectFrontend();
    const name = record.recipe?.name;
    if (typeof name === "string") {
      const digest = record.recipe?.artifact?.digest;
      const chosen = await recipeDriver(
        projectId,
        { name, ...(typeof digest === "string" ? { artifact: { digest } } : {}) },
        "use",
      );
      if (chosen) return chosen.driver;
    }
    return node;
  };

  const loaded = () => [...new Set([...recipeDrivers.values()])];

  return {
    name: "local-project",
    async adopt() {
      // Recipe runtimes are loaded before anything asks for a Project, so a
      // Project a recipe runs is recognised (and adopted) after a restart.
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
          try {
            await forProjectId(entry.name);
          } catch {
            // A Project this host cannot load is reported when it is started.
          }
        }
      } catch {
        // No Projects directory yet.
      }
      // Each driver knows which of its own Projects the Agent still runs; the
      // router only has to ask all of them.
      for (const driver of [node, ...loaded(), serverFrontend]) {
        await driver?.adopt?.();
      }
    },
    runtimeKinds: Object.freeze(["native"]),
    defaultRuntimeKind: "native",
    startupConcurrency: 1,
    capabilities: (project) => forDescriptor(project).capabilities(project),
    async prepare(project, recipe) {
      assertNative(project.runtimeKind);
      if (project.kind === SERVER_FRONTEND_KIND) return selectFrontend().prepare(project, recipe);
      const provided = await recipeDriver(project.id, recipe, "prepare");
      if (provided) {
        // The frozen digest goes into the lock the driver records.
        return provided.driver.prepare(project, { ...recipe, artifact: { digest: provided.digest } });
      }
      return node.prepare(project, recipe);
    },
    start: async (project, placement) => (await forProjectId(project.id)).start(project, placement),
    ...(agent.fencePlacement ? {
      fencePrevious: (placement) => agent.fencePlacement!(placement),
    } : {}),
    stop: async (id) => (await forProjectId(id)).stop(id),
    status: async (id) => {
      try { return await (await forProjectId(id)).status(id); }
      catch { return { status: "stopped" }; }
    },
    logs: async (id) => (await forProjectId(id)).logs(id),
    destroy: async (id) => {
      try { await (await forProjectId(id)).destroy(id); }
      catch { await node.destroy(id); }
      driverOfProject.delete(id);
    },
    close: async () => {
      await Promise.all([
        node.close(),
        ...loaded().map((driver) => driver.close()),
        serverFrontend?.close() ?? Promise.resolve(),
      ]);
    },
    signGatewayAuthority: async (id, claims) => {
      const selected = await forProjectId(id).catch(() => node);
      return selected.signGatewayAuthority?.(id, claims);
    },
  };
}
