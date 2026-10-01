/** Host-local installation names and inventory; no host imports. */
export function assertInstallationInstance(name: string): void {
  if (name !== "default" && !/^[a-z][a-z0-9-]{0,23}$/u.test(name)) throw new Error("Instance names must start with a lowercase letter and contain at most 24 lowercase letters, digits or hyphens.");
}
export function assertInstallationPort(port: number): void {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Installation port must be an integer between 1024 and 65535.");
}
export function installationInstanceScope(prefix: string, instance = "default") {
  assertInstallationInstance(instance);
  const named = instance !== "default";
  const directory = named ? `${prefix}/instances/${instance}` : prefix;
  const unit = (base: string) => named ? `${base}@${instance}.service` : `${base}.service`;
  const template = (base: string) => named ? `${base}@.service` : `${base}.service`;
  return { instance, named, directory, current: `${directory}/current`, receipt: `${directory}/installation.json`, runtime: `${directory}/runtime.json`, account: named ? `zelavis-${instance}` : "zelavis", units: [unit("zelavis"), unit("zelavis-agent"), ...(named ? [] : [unit("zelavis-traefik")])], templates: [template("zelavis"), template("zelavis-agent"), ...(named ? [] : [template("zelavis-traefik")])] };
}
