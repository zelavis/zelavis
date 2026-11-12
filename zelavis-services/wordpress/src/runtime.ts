import { createRecipeProjectRuntime, type ZelavisProjectRuntimeDriver, type ZelavisRecipeRuntimeContext } from "zelavis/adapters/project-runtime";

export const WORDPRESS_APP_NAME = "@zelavis/wordpress";

/**
 * The runtime the Platform loads from the frozen copy of this package.
 *
 * Everything about running WordPress is in `recipe.ts`; the Platform's recipe runtime supplies the
 * rest (finding Nginx, PHP-FPM and MariaDB, allocating ports, the OS account, supervising the
 * processes and adopting them after a restart). The only option is `user`: the unprivileged
 * account the daemons run as when the Platform is root.
 */
export function createProjectRuntime(context: ZelavisRecipeRuntimeContext): ZelavisProjectRuntimeDriver {
  const options = context.options as { user?: unknown };
  return createRecipeProjectRuntime({
    name: "native-wordpress",
    description: "Runs a version-pinned WordPress release with dedicated native Nginx, PHP-FPM, and MariaDB processes, configuration, sockets, logs, and data directories.",
    directory: context.directory,
    packageDirectory: context.packageDirectory,
    agent: context.agent,
    recipes: context.recipes,
    ...(typeof options.user === "string" ? { user: options.user } : {}),
  });
}
