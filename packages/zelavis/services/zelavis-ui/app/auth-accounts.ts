import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, field, node } from "./dom.ts";
import { canAccess } from "./navigation-menu.ts";
import { card, dataRow, rowsCard, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

const permission = (projectId?: string) => projectId
  ? { permissions: ["project.users.manage"], scope: { type: "project", projectId } }
  : { permissions: ["system.users.manage"], scope: { type: "system" } };

export function canManageAccounts(context: ScreenContext) {
  return canAccess(context.config.access, permission(context.projectId));
}

export const readAuthAccounts = (context: ScreenContext, api: string) => {
  const after = context.url.searchParams.get("accountAfter");
  const query = new URLSearchParams({ limit: "50" });
  if (after) query.set("after", after);
  return request(`${api}/accounts?${query}`).pipe(Effect.map(value => {
    const result = object(value);
    return { accounts: array(result.accounts).map(object), next: typeof result.next === "string" ? result.next : undefined, after };
  }));
};

export function accountPageControls(context: ScreenContext, page: Effect.Success<ReturnType<typeof readAuthAccounts>>) {
  if (!page.next && !page.after) return undefined;
  return node("nav", { class: "actions", "aria-label": "Account pages" },
    page.after ? button("First page", () => context.setSearch({ accountAfter: undefined, accountAccess: undefined, accountSessions: undefined })) : undefined,
    page.next ? button("Next page", () => context.setSearch({ accountAfter: page.next, accountAccess: undefined, accountSessions: undefined })) : undefined);
}

export function createAccountCard(context: ScreenContext, api: string) {
  if (!canManageAccounts(context)) return undefined;
  const username = field("username", "Username");
  username.querySelector("input")?.setAttribute("autocomplete", "off");
  const password = field("password", "Initial password", "password");
  password.querySelector("input")?.setAttribute("autocomplete", "new-password");
  password.querySelector("input")?.setAttribute("minlength", "15");
  const submit = node("button", { type: "submit", class: "primary" }, "Create user");
  const form = node("form", { class: "form", method: "post" }, username, field("displayName", "Display name (optional)", "text", "", false), password, submit);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (submit.disabled) return;
    const data = new FormData(form);
    const displayName = String(data.get("displayName") ?? "").trim();
    submit.disabled = true;
    context.run(request(`${api}/accounts`, "POST", {
      username: String(data.get("username") ?? "").trim(),
      password: String(data.get("password") ?? ""),
      ...(displayName ? { displayName } : {}),
    }).pipe(Effect.ensuring(Effect.sync(() => { submit.disabled = false; }))), () => {
      form.reset();
      setFlash("User created.");
      context.refresh();
    });
  });
  return card("Create user", form);
}

export const accountSessionsCard = Effect.fn("ui.auth.accountSessions")(function*(context: ScreenContext, api: string, accounts: Record<string, unknown>[]) {
  const selected = context.url.searchParams.get("accountSessions");
  if (!selected || !canManageAccounts(context)) return undefined;
  const account = accounts.find(entry => entry.id === selected);
  const close = button("Close sessions", () => context.setSearch({ accountSessions: undefined }));
  if (!account) return rowsCard("Account sessions", dataRow("Account not found on this page", ""), close);
  const path = `${api}/accounts/${encodeURIComponent(selected)}/sessions`;
  const result = yield* Effect.result(request(path));
  if (result._tag === "Failure") return rowsCard("Account sessions", dataRow(result.failure.message, ""), close);
  const sessions = array(object(result.success).sessions).map(object);
  const revoke = (target: string) => context.run(request(target, "DELETE"), () => context.refresh());
  const rows = sessions.map(session => dataRow(
    label(session.sessionId ?? session.id), typeof session.creationTime === "number" ? new Date(session.creationTime).toLocaleString() : "",
    button("Revoke session", () => revoke(`${path}/${encodeURIComponent(label(session.sessionId ?? session.id, ""))}`)),
  ));
  return rowsCard(`Sessions for ${label(account.displayName ?? account.username ?? account.email ?? selected)}`,
    ...(rows.length ? [...rows, button("Revoke all sessions", () => revoke(path))] : [dataRow("No active sessions", "")]), close);
});
