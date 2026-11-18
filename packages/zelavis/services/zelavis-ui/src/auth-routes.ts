export function isPublicAuthPath(path: string): boolean {
  return ["/login", "/setup", "/sign-up", "/forgot-password", "/reset-password", "/verify-email", "/change-email", "/invitation", "/mfa", "/oauth/callback"].includes(path.replace(/\/+$/, ""));
}
