/**
 * Which packages a service gets from the host, wherever its folder lies.
 *
 * A service is a folder of ES modules. Node finds the packages it imports by
 * walking up from that folder looking for `node_modules`, and a services folder
 * is usually nowhere near the host's: `/var/lib/zelavis/services` has no
 * `node_modules` above it, and under pnpm a project's `node_modules` holds only
 * what the project lists. So a service importing `effect` failed to load, which
 * is most of them.
 *
 * `zelavis` and `effect` are not the service's to choose. They are the host's,
 * and there must be exactly one copy of each: two copies of Effect hold two
 * unrelated sets of service tags and layers, and a service would silently talk to
 * nothing. So an import of either, from a file inside a services folder, resolves
 * from the host. Everything else a service imports it must carry itself (see the
 * acquisition check), because the Platform installs no one's dependencies.
 */
import { realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Bare specifiers that always come from the host. */
export const HOST_PROVIDED_PACKAGES = Object.freeze(["zelavis", "effect"] as const);

export function isHostProvided(specifier: string): boolean {
  return HOST_PROVIDED_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

const roots = new Set<string>();
let registered = false;

/** A file in the host's own package, whose resolution of `effect` and `zelavis` is the host's. */
const HOST_ANCHOR = import.meta.url;

function insideManagedRoot(file: string): boolean {
  for (const root of roots) {
    if (file === root || file.startsWith(root + sep)) return true;
  }
  return false;
}

function physical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Makes `zelavis` and `effect` resolve from the host for files under `directory`.
 * Idempotent, and process-wide because the module graph is.
 */
export function provideHostPackagesTo(directory: string): void {
  roots.add(physical(directory));
  if (registered) return;
  registered = true;

  // Node (22.15+) lets a module hook the resolver. Looked up here rather than
  // imported by name: Bun has no `registerHooks`, and a missing named import
  // would stop the whole module from loading there.
  const registerHooks = (nodeModule as { registerHooks?: (hooks: {
    resolve(
      specifier: string,
      context: { parentURL?: string | undefined },
      nextResolve: (specifier: string, context: { parentURL?: string | undefined }) => unknown,
    ): unknown;
  }) => unknown }).registerHooks;
  if (typeof registerHooks === "function") {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        const parent = context.parentURL;
        if (parent?.startsWith("file:") && isHostProvided(specifier)) {
          let file: string | undefined;
          try { file = physical(fileURLToPath(parent)); } catch { file = undefined; }
          if (file && insideManagedRoot(file)) {
            return nextResolve(specifier, { ...context, parentURL: HOST_ANCHOR });
          }
        }
        return nextResolve(specifier, context);
      },
    });
    return;
  }

  // Bun has no resolver hook that is called for these imports (its runtime
  // plugins are not, and it would quietly auto-install a second copy of `effect`
  // when it finds no node_modules), so there a service resolves the way Node
  // resolved before this existed: from the folders above it. Node is the
  // supported production host; see the Runtime Independence note in AGENTS.md.
}

/** For tests: the folders currently served by the hook. */
export function managedResolutionRoots(): readonly string[] {
  return [...roots];
}

/**
 * The runtime dependencies an acquired package lists that this host will not
 * provide. `zelavis` and `effect` are the host's; anything else would have to
 * be installed, and the Platform installs no one's dependencies (running an
 * installer on a server means install scripts, an unpinned tree no allow-list
 * digest covers, and a change to the host's own project). So a service carries
 * what it needs, bundled into its own files.
 */
export function unprovidedDependencies(manifest: unknown): readonly string[] {
  const dependencies = (manifest as { dependencies?: unknown } | undefined)?.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) return [];
  return Object.keys(dependencies).filter((name) => !isHostProvided(name)).sort();
}
