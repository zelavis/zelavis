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
  // The default instance's update units are the shared templates; a named instance's are rendered from
  // them, like its socket, because a path unit cannot be a template over another unit's data folder.
  const updatePath = named ? `zelavis-update-${instance}.path` : "zelavis-update.path";
  const updateService = named ? `zelavis-update-${instance}.service` : "zelavis-update.service";
  return { instance, named, socket: `zelavis${named ? `-${instance}` : ""}.socket`, directory, current: `${directory}/current`, receipt: `${directory}/installation.json`, runtime: `${directory}/runtime.json`, account: named ? `zelavis-${instance}` : "zelavis", units: [unit("zelavis"), unit("zelavis-agent"), ...(named ? [updatePath, updateService] : [unit("zelavis-traefik"), updatePath, updateService]), unit("zelavis-host-agent")], updatePath, updateService, templates: [template("zelavis"), template("zelavis-agent"), ...(named ? [] : [template("zelavis-traefik"), "zelavis-update.path", "zelavis-update.service"]), template("zelavis-host-agent")] };
}
