/**
 * Official Zelavis App Project recipe.
 *
 * A first-party Project recipe package (kind: "app") configured entirely via its
 * package.json manifest. Inside the module, it registers its Overview menu using
 * the official Zelavis SDK and registers a setup function that mounts the
 * project backend stack (database, auth, workloads).
 */
import { zelavis } from "zelavis/sdk";
import { mountAppServices } from "zelavis/app";

export function register() {
  zelavis.plugins.ui.menus.create({
    title: "Overview",
    path: "/",
    pageLabel: "Project",
    sectionLabel: "Overview",
    surface: "root" as const,
    access: {
      permissions: ["project.view"],
      scope: { type: "project" as const, projectIdParam: "projectId" },
    },
  });

  zelavis.setup(mountAppServices);
}
