export function getDatabaseSidebarTrail({
  databaseTable,
  systemTable,
}: {
  databaseTable?: string;
  systemTable?: string;
}) {
  return systemTable && !databaseTable
    ? "Backend/Database/System Tables"
    : "Backend/Database";
}
