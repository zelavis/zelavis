/**
 * A managed app recipe: the application is not built on Zelavis primitives, so
 * its Project gets hosting-style controls instead of the Zelavis-native
 * Auth/Database/Content navigation.
 *
 * Declared in the recipe's `package.json` under `zelavis.project.managed` and
 * locked with the recipe version. The dashboard renders what a recipe says here
 * rather than knowing any recipe by name.
 */
export interface ZelavisProjectManagedDefinition {
  /** Label of the app's own admin entry, such as "WordPress Admin". */
  readonly adminTitle?: string;
  /**
   * Path of the app's admin area on the Project's own address, such as
   * `/wp-admin/`. Always a plain absolute path, never a URL.
   */
  readonly adminPath?: string;
}

const MAX_TITLE = 60;
const MAX_PATH = 200;

/** Validates a recipe's managed declaration; anything unexpected is refused. */
export function normalizeProjectManaged(value: unknown): ZelavisProjectManagedDefinition | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Project managed metadata must be an object.");
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== "adminTitle" && key !== "adminPath") {
      throw new Error(`Unknown Project managed field "${key}".`);
    }
  }
  const { adminTitle, adminPath } = input;
  if (adminTitle !== undefined &&
      (typeof adminTitle !== "string" || !adminTitle.trim() || adminTitle.length > MAX_TITLE || /[\u0000-\u001f]/.test(adminTitle))) {
    throw new Error("Project managed adminTitle must be a short single-line string.");
  }
  if (adminPath !== undefined &&
      (typeof adminPath !== "string" || adminPath.length > MAX_PATH || !/^\/[A-Za-z0-9._~\-/]*$/.test(adminPath) ||
       adminPath.includes("//") || adminPath.split("/").includes(".."))) {
    throw new Error("Project managed adminPath must be a plain absolute path such as /wp-admin/.");
  }
  return Object.freeze({
    ...(adminTitle !== undefined ? { adminTitle } : {}),
    ...(adminPath !== undefined ? { adminPath } : {}),
  });
}
