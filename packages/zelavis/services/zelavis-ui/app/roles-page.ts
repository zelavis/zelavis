import { Effect, Schema } from "effect";
import type { RoleDefinitionInput } from "zelavis/sdk";
import { decode, request } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { canAccess } from "./navigation-menu.ts";
import { badge, card, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * Custom roles: the Platform's (`/server/access/roles`, `auth/roles`) or one App's (`/projects/:projectId/roles`, the
 * Gateway's exact `runtime/projects/:projectId/auth/roles`). A role is a named bundle of permissions; on the Platform it
 * can also carry concrete grants and Project permissions, given for each Project an assignment names. The page lists the
 * catalogue, edits one role at a time (`?role=<id>`, `?role=new`) and deletes one after its id is typed (`?roleDelete=<id>`).
 */

const Scope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("system") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("service"), serviceName: Schema.String }),
]);
const Role = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  description: Schema.optional(Schema.String),
  permissions: Schema.Array(Schema.String),
  grants: Schema.Array(Schema.Struct({ permission: Schema.String, scope: Scope })),
  projectPermissions: Schema.Array(Schema.String),
});
export const RoleCatalogue = Schema.Struct({ revision: Schema.Natural, roles: Schema.Array(Role) });
export type RoleCatalogueView = typeof RoleCatalogue.Type;
export type RoleView = typeof Role.Type;

export const rolesUrl = (context: ScreenContext, projectId?: string) => projectId === undefined
  ? `${context.config.api.basePath}/auth/roles`
  : `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/auth/roles`;

/** The catalogue as the caller may read it; a failure is data, so a page can still render without it. */
export const readRoleCatalogue = (context: ScreenContext, projectId?: string) =>
  request(rolesUrl(context, projectId)).pipe(Effect.flatMap(value => decode(RoleCatalogue, value)), Effect.result);

export const canManageRoles = (context: ScreenContext, projectId?: string) => canAccess(context.config.access, projectId === undefined
  ? { permissions: ["system.roles.manage"], scope: { type: "system" } }
  : { permissions: ["project.users.manage"], scope: { type: "project", projectId } });

const lines = (value: string) => [...new Set(value.split(/[\n,]/u).map(line => line.trim()).filter(Boolean))];

const grantText = (grant: RoleView["grants"][number]) => grant.scope.type === "project" ? `${grant.permission} project:${grant.scope.projectId}`
  : grant.scope.type === "service" ? `${grant.permission} service:${grant.scope.serviceName}` : `${grant.permission} system`;

/** One grant per line: `<permission> project:<id>`, `<permission> service:<name>` or `<permission> system`. */
function parseGrants(value: string): RoleView["grants"][number][] | string {
  const grants: RoleView["grants"][number][] = [];
  for (const line of lines(value.replaceAll(",", "\n"))) {
    const [permission, target, ...rest] = line.split(/\s+/u);
    if (!permission || !target || rest.length > 0) return `“${line}” is not “permission project:<id>”, “permission service:<name>” or “permission system”.`;
    if (target === "system") grants.push({ permission, scope: { type: "system" } });
    else if (target.startsWith("project:") && target.length > 8) grants.push({ permission, scope: { type: "project", projectId: target.slice(8) } });
    else if (target.startsWith("service:") && target.length > 8) grants.push({ permission, scope: { type: "service", serviceName: target.slice(8) } });
    else return `“${line}” names no project, service or system scope.`;
  }
  return grants;
}

const summary = (role: RoleView, platform: boolean) => [
  role.id,
  `${role.permissions.length} permission${role.permissions.length === 1 ? "" : "s"}`,
  ...(platform ? [`${role.projectPermissions.length} Project permission${role.projectPermissions.length === 1 ? "" : "s"}`, `${role.grants.length} grant${role.grants.length === 1 ? "" : "s"}`] : []),
].join(" · ");

export const rolesScreen = Effect.fn("ui.roles")(function*(context: ScreenContext, projectId?: string) {
  const platform = projectId === undefined;
  const url = rolesUrl(context, projectId);
  const catalogue = yield* readRoleCatalogue(context, projectId);
  if (catalogue._tag === "Failure") return page(message(catalogue.failure.message, true));
  const { revision, roles } = catalogue.success;
  const manage = canManageRoles(context, projectId);
  const editing = context.url.searchParams.get("role");
  const deleting = context.url.searchParams.get("roleDelete");
  const status = node("div", { role: "status" });
  const conflict = "The roles changed since this page was opened. Review the current roles and reapply your change.";
  const submit = (path: string, method: string, body: RoleDefinitionInput | undefined, done: string) => {
    status.replaceChildren();
    context.run(request(path, method, body).pipe(Effect.result), result => {
      if (!status.isConnected) return;
      if (result._tag === "Failure") {
        if (result.failure.code === "role_revision_conflict") { setFlash(conflict, url); context.refresh(); return; }
        status.replaceChildren(message(result.failure.message, true));
        return;
      }
      setFlash(done, url);
      context.setSearch({ role: undefined, roleDelete: undefined });
    });
  };

  let editor: HTMLElement | undefined;
  const current = editing === null || editing === "new" ? undefined : roles.find(role => role.id === editing);
  if (manage && (editing === "new" || current !== undefined)) {
    const input = (name: string, value: string, attributes: Record<string, string> = {}) =>
      node("input", { name, value, autocomplete: "off", ...attributes });
    const area = (name: string, value: readonly string[], placeholder: string) => {
      const element = node("textarea", { name, rows: "4", placeholder, spellcheck: "false" });
      element.value = value.join("\n");
      return element;
    };
    const id = input("id", current?.id ?? "", { required: "", pattern: "[a-z][a-z0-9-]{1,47}", maxlength: "48", ...(current ? { readonly: "" } : {}) });
    const title = input("title", current?.title ?? "", { required: "", maxlength: "80" });
    const description = area("description", current?.description === undefined ? [] : [current.description], "What this role is for (optional)");
    const permissions = area("permissions", current?.permissions ?? [], platform ? "One permission per line, held runtime-wide" : "One permission per line, held on this App");
    const projectPermissions = area("projectPermissions", current?.projectPermissions ?? [], "One permission per line, given on each Project an assignment names");
    const grants = area("grants", (current?.grants ?? []).map(grantText), "One grant per line: permission project:<id>");
    const form = node("form", { class: "form" },
      node("label", {}, node("span", {}, "Role id"), id),
      node("label", {}, node("span", {}, "Title"), title),
      node("label", {}, node("span", {}, "Description"), description),
      node("label", {}, node("span", {}, "Permissions"), permissions),
      ...(platform ? [
        node("label", {}, node("span", {}, "Project permissions"), projectPermissions),
        node("label", {}, node("span", {}, "Grants"), grants),
      ] : []),
      status,
      node("p", { class: "muted" }, "Members get the role's authority on their next request; saving signs nobody out. You can only save a role whose every permission you could give yourself."),
      node("div", { class: "actions" },
        node("button", { type: "submit", class: "primary" }, current ? "Save role" : "Create role"),
        button("Cancel", () => context.setSearch({ role: undefined }))));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const parsed = platform ? parseGrants(grants.value) : [];
      if (typeof parsed === "string") { status.replaceChildren(message(parsed, true)); return; }
      const body: RoleDefinitionInput = {
        id: id.value.trim(), title: title.value.trim(),
        ...(description.value.trim() ? { description: description.value.trim() } : {}),
        permissions: lines(permissions.value),
        grants: parsed,
        projectPermissions: platform ? lines(projectPermissions.value) : [],
        expectedRevision: revision,
      };
      if (current) submit(`${url}/${encodeURIComponent(current.id)}`, "PUT", body, "Role saved.");
      else submit(url, "POST", body, "Role created.");
    });
    editor = card(current ? `Edit ${current.title}` : "New role", form);
  }

  let confirmation: HTMLElement | undefined;
  const doomed = deleting === null ? undefined : roles.find(role => role.id === deleting);
  if (manage && doomed !== undefined) {
    const typed = node("input", { name: "confirm", autocomplete: "off" });
    const remove = node("button", { type: "submit", class: "danger", disabled: "" }, "Delete role");
    typed.addEventListener("input", () => { remove.disabled = typed.value !== doomed.id; });
    const form = node("form", { class: "form" },
      message(`Deleting ${doomed.title} takes its authority from every member at their next request. Their accounts keep the assignment until their access is next edited, so a role created later with the id ${doomed.id} would give its authority to them.`),
      node("label", {}, node("span", {}, `Type ${doomed.id} to confirm`), typed),
      status,
      node("div", { class: "actions" }, remove, button("Cancel", () => context.setSearch({ roleDelete: undefined }))));
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (typed.value !== doomed.id) return;
      submit(`${url}/${encodeURIComponent(doomed.id)}?revision=${revision}`, "DELETE", undefined, "Role deleted.");
    });
    confirmation = card(`Delete ${doomed.title}`, form);
  }

  return page(
    flashNotice("Roles", url),
    editor,
    confirmation,
    manage && editor === undefined ? node("div", { class: "actions" }, button("New role", () => context.setSearch({ role: "new", roleDelete: undefined }), { class: "primary" })) : undefined,
    rowsCard(`Roles (${roles.length} of 50)`, ...(roles.length ? roles.map(role => dataRow(role.title, summary(role, platform),
      manage ? node("div", { class: "actions" },
        button("Edit", () => context.setSearch({ role: role.id, roleDelete: undefined }), { "aria-label": `Edit role ${role.title}` }),
        button("Delete", () => context.setSearch({ roleDelete: role.id, role: undefined }), { class: "danger", "aria-label": `Delete role ${role.title}` }))
        : badge("active"))) : [dataRow("No roles yet", platform
      ? "A role bundles permissions, grants and Project permissions so many accounts can share one definition."
      : "A role bundles permissions on this App so many users can share one definition.")])),
    resourceNotice("Roles are assigned in each account's access", platform
      ? "Open Users, choose Edit access on an account and assign a role, optionally for Projects. Its Project permissions apply to exactly the Projects the assignment names."
      : "Open Users, choose Edit access on a user and assign a role. Its permissions apply to this App."));
});
