/**
 * Dashboard paths the Fuzor dashboard renders itself. Everything else in the legacy route inventory is
 * still served by the React workspace frame. A page moves here when its native screen exists; the route
 * parity test reads this file, so keep it a plain list of string literals.
 */
export const nativePaths = [
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
  "/server/access/permissions"
] as const;
