/**
 * Official Zelavis App Project recipe.
 *
 * A first-party Project recipe package (kind: "app") configured entirely via its
 * package.json manifest. Inside the module, it registers its Overview menu using
 * the official Zelavis SDK. The backend stack (database, auth, workloads) is
 * not mounted by this package: a Project runtime composes those subsystems
 * itself, exactly as the Platform does, so the recipe carries identity, menu
 * and defaults only.
 */
import { zelavis } from "zelavis/sdk";

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

}
