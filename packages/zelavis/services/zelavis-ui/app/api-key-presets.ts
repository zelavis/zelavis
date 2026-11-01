/**
 * What an API key may do is a list of permissions, chosen when it is made. The presets name the usual shapes;
 * none of them includes the terminal, user management, package installation or Project deletion, which stay with
 * a person. A key is a service account: it can be rotated or revoked at any time and shows its token once.
 */

export const DEBUG_PERMISSIONS = [
  "server.debug.read", "server.logs.read", "system.updates.view", "server.nodes.view", "server.agents.view",
  "server.backends.view", "server.cloud.view", "server.edge.view", "projects.list", "project.view", "project.logs.read",
] as const;

export const OPERATOR_PERMISSIONS = [
  ...DEBUG_PERMISSIONS,
  "system.updates.manage", "system.services.manage", "system.settings.manage", "server.nodes.manage", "server.edge.manage",
  "server.cloud.manage", "server.backends.manage", "projects.create", "project.runtime.manage", "project.settings.manage",
] as const;

export const API_KEY_PRESETS = [
  { id: "debug", title: "Debug (read-only)", detail: "Reads logs, processes, nodes, updates and Projects. Changes nothing.", permissions: DEBUG_PERMISSIONS },
  { id: "operator", title: "Operator (control)", detail: "Debug, plus updates, services, settings, nodes, Edge, cloud and Project lifecycle. No terminal, users or deletion.", permissions: OPERATOR_PERMISSIONS },
  { id: "client", title: "Project client", detail: "Lists and creates Projects; optionally scoped grants on one Project.", permissions: ["projects.list", "projects.create"] },
] as const;

export type ApiKeyPresetId = (typeof API_KEY_PRESETS)[number]["id"];
