export function isPublicAuthPath(path: string): boolean {
  return ["/login", "/setup", "/sign-up"].includes(path.replace(/\/+$/, ""));
}
