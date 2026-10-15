/**
 * Dashboard paths the Fuzor dashboard renders itself. Everything else in the legacy route inventory is
 * still served by the React workspace frame. A page moves here when its native screen exists; the route
 * parity test reads this file, so keep it a plain list of string literals.
 */
export const nativePaths = [
  "/",
  "/projects",
  "/projects?new=1",
  "/settings",
  "/settings/appearance",
  "/services",
  "/server/logs",
  "/server/terminal",
  "/server",
  "/server/backups",
  "/server/runtimes",
  "/server/domains",
  "/server/database",
  "/server/security",
  "/server/access",
  "/server/access/users",
  "/server/access/permissions",
  "/server/resources",
  "/server/fabric",
  "/server/fabric/:fabricSection",
  "/server/fabric/:fabricSection/:fabricDetail",
  "/server/fabric/placements",
  "/server/fabric/migrations",
  "/server/fabric/data",
  "/server/fabric/data/shards",
  "/server/fabric/data/replicas",
  "/server/fabric/data/schema-rollouts",
  "/server/fabric/infrastructure",
  "/server/fabric/infrastructure/providers",
  "/server/fabric/infrastructure/autoscaling",
  "/server/fabric/settings",
  "/server/fabric/settings/placement-policies",
  "/server/fabric/settings/networking",
  "/server/fabric/settings/limits"
] as const;
