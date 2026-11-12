import { Effect, Schema } from "effect";
import type { ConcreteAccountGrant, HumanAccountRole, SetAccountAccessInput } from "zelavis/app/identity";
import type { ZelavisPrincipalGrant } from "zelavis/core";
import { array, decode, label, object, projects, request } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { dropdown } from "./dropdown.ts";
import { canAccess } from "./navigation-menu.ts";
import { card, dataRow, flashNotice, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

// Decode only the access fields presented by the administrative accounts list.
const Scope = Schema.Union([
  Schema.Struct({ type: Schema.Literal("system") }),
  Schema.Struct({ type: Schema.Literal("project"), projectId: Schema.optional(Schema.String), projectIdParam: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("service"), serviceName: Schema.optional(Schema.String), serviceNameParam: Schema.optional(Schema.String) }),
]);
const Access = Schema.Struct({
  id: Schema.String,
  accessRevision: Schema.Natural,
  roles: Schema.optional(Schema.Array(Schema.String)),
  permissions: Schema.optional(Schema.Array(Schema.String)),
  grants: Schema.optional(Schema.Array(Schema.Struct({ permission: Schema.String, scope: Schema.optional(Scope) }))),
});
const roles: readonly HumanAccountRole[] = ["customer", "operator", "reseller"];
const grantChoices = [
  { value: "project.view", label: "View project and inspect backend" },
  { value: "project.domains.view", label: "View Project domains" },
  { value: "project.domains.manage", label: "Manage Project domains" },
];

function concreteGrant(grant: ZelavisPrincipalGrant): grant is ConcreteAccountGrant {
  const scope = grant.scope;
  if (grant.permission === "*" || !scope) return false;
  if (scope.type === "system") return true;
  return scope.type === "project"
    ? !!scope.projectId && scope.projectIdParam === undefined
    : !!scope.serviceName && scope.serviceNameParam === undefined;
}

function protectedAccount(context: ScreenContext, account: Record<string, unknown>) {
  const metadata = object(account.metadata);
  return account.id === object(object(context.config.access).principal).id ||
    array(account.roles).some(role => ["owner", "service", "system"].includes(String(role))) ||
    ["service", "system"].includes(String(metadata.principalType)) || metadata.serviceAccount === true;
}

export function canEditAccountAccess(context: ScreenContext, account: Record<string, unknown>, projectId?: string) {
  const requirement = projectId
    ? { permissions: ["project.users.manage"], scope: { type: "project", projectId } }
    : { permissions: ["system.users.manage"], scope: { type: "system" } };
  return canAccess(context.config.access, requirement) && !protectedAccount(context, account);
}

export const accountAccessEditor = Effect.fn("ui.accountAccessEditor")(function*(
  context: ScreenContext,
  accounts: readonly Record<string, unknown>[],
  projectId?: string,
) {
  const selected = context.url.searchParams.get("accountAccess");
  if (!selected) return undefined;
  const close = () => context.setSearch({ accountAccess: undefined });
  const account = accounts.find(account => account.id === selected);
  if (!account || !canEditAccountAccess(context, account, projectId)) {
    return card("Account access", message(account ? "This account’s access is protected." : "Account not found.", true), button("Close access editor", close));
  }
  const decoded = yield* Effect.result(decode(Access, account));
  if (decoded._tag === "Failure") {
    return card("Account access", message(decoded.failure.message, true), button("Close access editor", close));
  }
  const current = decoded.success;
  const inventory = projectId
    ? [{ id: projectId, name: projectId }]
    : yield* projects(context.config);
  const permissions = [...(current.permissions ?? [])];
  const grants: ZelavisPrincipalGrant[] = [...(current.grants ?? [])];
  const principal = object(object(context.config.access).principal);
  const roleChoices: readonly string[] = projectId ? ["user"] : roles.filter(role => role === "customer" || array(principal.permissions).includes("*") || array(principal.roles).includes(role));
  const currentRole = current.roles?.length === 1 && roleChoices.includes(current.roles[0]) ? current.roles[0] : "";
  const role = dropdown({ label: "Account role", value: currentRole, placeholder: "Choose a role", disabled: !!projectId },
    roleChoices.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })));
  let selectedRole = projectId ? "user" : currentRole;
  const availableProjects = inventory.filter(project => canAccess(context.config.access, {
    permissions: ["project.view"], scope: { type: "project", projectId: project.id },
  }));
  const project = dropdown({ label: "Grant project", placeholder: "Choose a project", value: projectId, disabled: !!projectId },
    availableProjects.map(project => ({ value: project.id, label: project.name })));
  const choices = projectId ? grantChoices.slice(0, 1) : grantChoices;
  const permission = dropdown({ label: "Grant permission", value: "project.view" }, choices);
  const mayGrant = () => availableProjects.some(candidate => candidate.id === project.value) &&
    choices.some(choice => choice.value === permission.value) &&
    canAccess(context.config.access, { permissions: [permission.value], scope: { type: "project", projectId: project.value } });
  const status = node("div", { role: "status" });
  const rows = node("div");
  const save = node("button", { type: "submit", class: "primary", disabled: "" }, "Save access");
  const add = button("Add grant", () => {
    const projectId = project.value;
    if (!mayGrant()) return;
    if (grants.some(grant => grant.permission === permission.value && grant.scope?.type === "project" && grant.scope.projectId === projectId)) return;
    if (permissions.length + grants.length >= 100) { status.replaceChildren(message("Access supports at most 100 permissions and grants.", true)); return; }
    grants.push({ permission: permission.value, scope: { type: "project", projectId } });
    draw();
  });
  const scopeText = ({ scope }: ZelavisPrincipalGrant) => {
    if (!scope) return "Runtime-wide grant";
    if (scope.type === "project") return `Project ${inventory.find(project => project.id === scope.projectId)?.name ?? scope.projectId ?? scope.projectIdParam ?? "(unresolved)"}`;
    return scope.type === "service" ? `Service ${scope.serviceName ?? scope.serviceNameParam ?? "(unresolved)"}` : "System";
  };
  function draw() {
    rows.replaceChildren(
      ...permissions.map((name, index) => dataRow(name, "Runtime-wide permission", button("Remove permission", () => { permissions.splice(index, 1); draw(); }, { "aria-label": `Remove permission ${name}` }))),
      ...grants.map((grant, index) => dataRow(grant.permission, scopeText(grant), button("Remove grant", () => { grants.splice(index, 1); draw(); }, { "aria-label": `Remove ${grant.permission} from ${scopeText(grant)}` }))),
      ...(!permissions.length && !grants.length ? [node("p", { class: "muted" }, "No permissions or scoped grants.")] : []));
    const concrete = !permissions.includes("*") && grants.every(concreteGrant);
    const compatible = !projectId || !permissions.length && grants.every(grant => grant.scope?.type === "project" && grant.scope.projectId === projectId);
    const withinLimit = permissions.length + grants.length <= 100;
    const changed = selectedRole !== currentRole || JSON.stringify(permissions) !== JSON.stringify(current.permissions ?? []) || JSON.stringify(grants) !== JSON.stringify(current.grants ?? []);
    save.disabled = !selectedRole || !concrete || !compatible || !withinLimit || !changed;
    add.disabled = !mayGrant();
    if (!withinLimit) status.replaceChildren(message("Access supports at most 100 permissions and grants.", true));
    else if (!concrete) status.replaceChildren(message("Saving requires concrete scoped grants and explicit permission names. Remove incompatible existing access before saving.", true));
    else if (!compatible) status.replaceChildren(message("App access uses the User role and grants within this Project. Remove incompatible existing access before saving.", true));
    else status.replaceChildren();
  }
  role.addEventListener("change", () => { selectedRole = role.value; draw(); });
  project.addEventListener("change", draw);
  permission.addEventListener("change", draw);
  draw();
  const form = node("form", { class: "form" },
    flashNotice("Account access"),
    node("label", {}, node("span", {}, "Role"), role),
    ...(current.roles?.length !== 1 ? [message("Saving replaces the existing role list with the selected role.")] : []),
    node("div", {}, node("h3", {}, "Current permissions and grants"), rows),
    node("label", {}, node("span", {}, "Project"), project),
    node("label", {}, node("span", {}, "Permission"), permission), add, status,
    node("p", { class: "muted" }, "Saving a change signs this account out of its existing sessions."),
    node("div", { class: "actions" }, save, button("Cancel", close)));
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (save.disabled || ![...roles, "user"].includes(selectedRole as HumanAccountRole) || !grants.every(concreteGrant)) return;
    const input: SetAccountAccessInput = {
      expectedRevision: current.accessRevision,
      role: selectedRole as HumanAccountRole,
      permissions: [...permissions],
      grants: grants.filter(concreteGrant),
    };
    const path = projectId
      ? `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/auth/accounts/${encodeURIComponent(current.id)}/access`
      : `${context.config.api.basePath}/auth/accounts/${encodeURIComponent(current.id)}/access`;
    role.disabled = true; project.disabled = true; permission.disabled = true;
    const update = Effect.result(request(path, "PUT", input)).pipe(Effect.ensuring(Effect.sync(() => {
      role.disabled = !!projectId; project.disabled = !!projectId; permission.disabled = false;
    })));
    context.run(update, result => {
      if (location.pathname !== context.url.pathname || new URL(location.href).searchParams.get("accountAccess") !== current.id) return;
      if (result._tag === "Success") {
        setFlash("Account access saved.");
        close();
      } else {
        setFlash(result.failure.code === "account_access_conflict"
          ? "Account access changed. Review the current access and reapply your change."
          : result.failure.message);
        context.refresh();
      }
    });
  });
  const drawer = node("dialog", { class: "account-access-drawer", "aria-label": `Edit access for ${label(account.displayName ?? account.email ?? account.username ?? account.id)}` },
    node("div", { class: "toolbar" }, node("h2", {}, "Edit access"), button("Close", close)), form);
  drawer.addEventListener("cancel", event => { event.preventDefault(); close(); });
  drawer.addEventListener("keydown", event => { event.stopPropagation(); });
  requestAnimationFrame(() => { if (drawer.isConnected) drawer.showModal(); });
  return drawer;
});
