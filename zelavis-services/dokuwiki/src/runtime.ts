import { createRecipeProjectRuntime, type ZelavisProjectRuntimeDriver, type ZelavisRecipeRuntimeContext } from "zelavis/adapters/project-runtime";

export const DOKUWIKI_APP_NAME = "@zelavis/dokuwiki";

/**
 * The runtime the Platform loads from the frozen copy of this package: the Platform's recipe runtime
 * over this package's recipe. The only option is `user`, the unprivileged account the daemons run as
 * when the Platform is root.
 */
export function createProjectRuntime(context: ZelavisRecipeRuntimeContext): ZelavisProjectRuntimeDriver {
  const options = context.options as { user?: unknown };
  return createRecipeProjectRuntime({
    name: "native-dokuwiki",
    description: "Runs a version-pinned DokuWiki release with dedicated native Nginx and PHP-FPM processes, configuration, sockets, logs and a flat-file data directory.",
    directory: context.directory,
    packageDirectory: context.packageDirectory,
    agent: context.agent,
    recipes: context.recipes,
    ...(typeof options.user === "string" ? { user: options.user } : {}),
  });
}
