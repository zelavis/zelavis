import { Effect, Schema } from "effect";
import type { ConcreteAccountGrant, CreateInvitationInput } from "zelavis/sdk";
import { accountAccessGrantChoices, assignableAccountRoles } from "./account-access-editor.ts";
import { decode, projects, request } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { dropdown, setDropdownOptions } from "./dropdown.ts";
import { canAccess } from "./navigation-menu.ts";
import { badge, card, dataRow, flashNotice, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

const InvitationPage = Schema.Struct({
  invitations: Schema.Array(Schema.Struct({
    id: Schema.String, email: Schema.String, expiresAt: Schema.String,
    status: Schema.Literals(["pending", "accepted", "revoked"]),
    access: Schema.Struct({ role: Schema.String }),
  })),
  next: Schema.optional(Schema.String),
});

export const invitationsPanel = Effect.fn("ui.invitations")(function*(context: ScreenContext, projectId?: string) {
  const scope = projectId === undefined ? { type: "system" } : { type: "project", projectId };
  if (!canAccess(context.config.access, { permissions: [projectId === undefined ? "system.users.manage" : "project.users.manage"], scope })) return undefined;
  const root = context.config.api.basePath;
  const url = projectId === undefined ? `${root}/auth/invitations`
    : `${root}/runtime/projects/${encodeURIComponent(projectId)}/auth/invitations`;
  const after = context.url.searchParams.get("invitationsAfter");
  const list = yield* request(after === null ? url : `${url}?after=${encodeURIComponent(after)}`).pipe(
    Effect.flatMap(value => decode(InvitationPage, value)),
    Effect.result,
  );
  const creating = context.url.searchParams.get("invite") === "1";
  const status = node("div", { role: "status" });
  const submit = (path: string, method: string, confirmation: string, body?: CreateInvitationInput) => {
    status.replaceChildren();
    context.run(request(path, method, body).pipe(Effect.result), result => {
      if (!status.isConnected) return;
      if (result._tag === "Failure") {
        status.replaceChildren(message(result.failure.message, true));
        return;
      }
      setFlash(confirmation, url);
      if (body !== undefined) context.setSearch({ invite: undefined, invitationsAfter: undefined });
      else context.refresh();
    });
  };

  const rows = (list._tag === "Success" ? list.success.invitations : []).map(invitation => {
    const expires = new Date(invitation.expiresAt);
    const pending = invitation.status === "pending";
    const expired = pending && expires.getTime() <= Date.now();
    const path = `${url}/${encodeURIComponent(invitation.id)}`;
    const label = expired ? "expired" : invitation.status;
    return dataRow(invitation.email, `${invitation.access.role} · Expires ${expires.toLocaleDateString()}`,
      node("div", { class: "actions" }, badge(label),
        pending && !expired ? button("Resend", () => submit(`${path}/resend`, "POST", "Invitation resent."),
          { "aria-label": `Resend invitation to ${invitation.email}` }) : undefined,
        pending ? button("Revoke", () => submit(path, "DELETE", "Invitation revoked."),
          { "aria-label": `Revoke invitation to ${invitation.email}` }) : undefined));
  });

  let form: HTMLFormElement | undefined;
  if (creating) {
    const inventory = projectId === undefined ? yield* projects(context.config) : [{ id: projectId, name: projectId }];
    const choices = inventory.flatMap(project => accountAccessGrantChoices.flatMap(permission =>
      canAccess(context.config.access, { permissions: [permission.value], scope: { type: "project", projectId: project.id } })
        ? [{ project, permission }] : []));
    const roleOptions = assignableAccountRoles(context, projectId);
    const email = node("input", { type: "email", name: "email", maxlength: "254", autocomplete: "email", required: "" });
    const role = dropdown({ label: "Invitation role", value: roleOptions[0], disabled: projectId !== undefined },
      roleOptions.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) })));
    const project = dropdown({ label: "Invitation project", value: projectId, placeholder: "Choose a project", disabled: projectId !== undefined },
      inventory.filter(candidate => choices.some(choice => choice.project.id === candidate.id)).map(candidate => ({ value: candidate.id, label: candidate.name })));
    const permission = dropdown({ label: "Invitation permission", placeholder: "Choose a permission" }, []);
    const grants: ConcreteAccountGrant[] = [];
    const selected = node("div");
    const add = button("Add grant", () => {
      const choice = choices.find(choice => choice.project.id === project.value && choice.permission.value === permission.value);
      if (!choice || grants.length >= 100 || grants.some(grant => grant.scope.type === "project" &&
          grant.scope.projectId === choice.project.id && grant.permission === choice.permission.value)) return;
      grants.push({ permission: choice.permission.value, scope: { type: "project", projectId: choice.project.id } });
      drawGrants();
    });
    function drawGrants() {
      selected.replaceChildren(...grants.map((grant, index) => {
        const grantedScope = grant.scope;
        const target = grantedScope.type === "project" ? inventory.find(item => item.id === grantedScope.projectId)?.name : undefined;
        return dataRow(grant.permission, target ?? "", button("Remove", () => { grants.splice(index, 1); drawGrants(); },
          { "aria-label": `Remove ${grant.permission} from ${target ?? "project"}` }));
      }));
    }
    const updatePermissions = () => {
      const options = choices.filter(choice => choice.project.id === project.value).map(choice => choice.permission);
      setDropdownOptions(permission, options, options[0]?.value ?? "");
      add.disabled = options.length === 0;
    };
    project.addEventListener("change", updatePermissions);
    updatePermissions();
    form = node("form", { class: "form" },
      node("label", {}, node("span", {}, "Email address"), email),
      node("label", {}, node("span", {}, "Role"), role),
      choices.length ? node("div", { class: "form" },
        projectId === undefined ? node("label", {}, node("span", {}, "Project"), project) : undefined,
        node("label", {}, node("span", {}, "Permission"), permission), add, selected) : undefined,
      node("div", { class: "actions" },
        node("button", { type: "submit", class: "primary" }, "Send invitation"),
        button("Cancel", () => context.setSearch({ invite: undefined }))));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const selectedRole = roleOptions.find(option => option === role.value);
      if (selectedRole === undefined) return;
      submit(url, "POST", "Invitation sent.", { email: email.value.trim(), access: { role: selectedRole, permissions: [], grants: [...grants], roleAssignments: [] } });
    });
  }
  const next = list._tag === "Success" ? list.success.next : undefined;
  return card("Invitations", flashNotice("Invitations", url),
    form ?? button("Invite user", () => context.setSearch({ invite: "1" }), { class: "primary" }),
    status, list._tag === "Failure" ? message(list.failure.message, true) : undefined,
    ...rows, list._tag === "Success" && rows.length === 0 ? node("p", { class: "muted" }, "No invitations.") : undefined,
    after !== null || next !== undefined ? node("div", { class: "actions" },
      after === null ? undefined : button("Newest", () => context.setSearch({ invitationsAfter: undefined })),
      next === undefined ? undefined : button("Next page", () => context.setSearch({ invitationsAfter: next }))) : undefined);
});
