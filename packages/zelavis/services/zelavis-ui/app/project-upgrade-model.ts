import { label, object } from "./api.ts";

/** True when a Project is a managed third-party app (e.g. WordPress, DokuWiki, Drupal) rather than a native Zelavis App. */
export function isManagedProject(project: Record<string, unknown>): boolean {
  const recipe = object(project.recipe);
  const capabilities = object(project.capabilities);
  return Object.keys(object(recipe.managed)).length > 0 || capabilities.recipeUpdateMode === "integration";
}

/**
 * Whether a Project card on /projects should show an upgrade or recovery notice.
 * Managed apps migrate their bound integration layout automatically and keep routine
 * recipe update controls under Project → Updates/Settings, so their /projects cards stay
 * clean unless an operation is actively running or requires error recovery.
 */
export function shouldShowCardUpgradeNotice(project: Record<string, unknown>): boolean {
  if (project.deletion) return false;
  const upgrade = project.upgrade ? object(project.upgrade) : undefined;
  if (upgrade?.state === "running" || upgrade?.state === "failed" || project.runtimeUpdate) return true;
  const layout = project.dataLayout ? object(project.dataLayout) : undefined;
  if (isManagedProject(project)) {
    return object(layout?.autoMigration).state === "failed";
  }
  const recipeStatus = project.recipeStatus ? object(project.recipeStatus) : undefined;
  return Boolean((recipeStatus && recipeStatus.state !== "current") || layout);
}

/** What a data-layout migration changed, for the line shown after an upgrade; an upgrade that migrated nothing leaves the data as it was. */
function migrationSummary(value: unknown): string {
  const migration = object(value);
  if (migration.from === undefined || migration.to === undefined) return "Its data is unchanged.";
  const docs = Number(migration.documents ?? 0);
  const events = Number(migration.eventsCarried ?? 0);
  const restarted = Number(migration.documentsWithHistoryDropped ?? 0);
  if (docs === 0 && events === 0 && migration.retained === undefined) {
    return `Its data layout moved from format ${label(migration.from)} to format ${label(migration.to)}.`;
  }
  const backup = typeof migration.retained === "string"
    ? " A pre-upgrade backup was kept until you delete it."
    : "";
  return `Its data moved from layout ${label(migration.from)} to ${label(migration.to)} (${docs} documents recreated with their versions, ${events} change events carried${restarted > 0 ? `; ${restarted} documents of compacted Tenants kept their versions without their earlier change history` : ""}).${backup}`;
}

export function upgradeDoneMessage(project: Record<string, unknown>, mode: "recipe" | "version" | "migration", fallbackVersion?: string): string {
  const name = label(project.name);
  const upgrade = object(project.upgrade);
  const migration = upgrade.dataMigration ?? project.dataMigration;
  if (mode === "migration") {
    return `${name}'s integration data is up to date. ${migrationSummary(migration)}`;
  }
  if (mode === "version") {
    return `${name} now uses Zelavis ${label(project.engineVersion, fallbackVersion ?? "")}. ${migrationSummary(migration)}`;
  }
  const next = object(project.recipe);
  return `${name} now uses ${label(next.name)}${next.version ? ` ${label(next.version)}` : ""}. ${migrationSummary(migration)} ${object(project.runtime).status === "running" ? "It is running at the same address." : "Start it when you are ready."}`;
}
