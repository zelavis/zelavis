import { Effect, Schema } from "effect";
import { decode, request } from "./api.ts";
import { button, node } from "./dom.ts";
import { card, flashNotice, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

const Methods = Schema.Struct({ enabled: Schema.Array(Schema.String), revision: Schema.Natural });
const Passkeys = Schema.Struct({ rpId: Schema.String, rpName: Schema.String, origins: Schema.Array(Schema.String) });
const Mfa = Schema.Struct({ requiredFor: Schema.Literals(["none", "privileged", "all"]), revision: Schema.Natural });

export const projectAuthSettingsCards = Effect.fn("ui.projectAuthSettings")(function*(context: ScreenContext, projectId: string) {
  const api = `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/auth`;
  const [methods, passkeys, policy] = yield* Effect.all([
    request(`${api}/methods/settings`).pipe(Effect.flatMap(value => decode(Methods, value))),
    request(`${api}/passkeys/settings`).pipe(Effect.flatMap(value => decode(Passkeys, value))),
    request(`${api}/mfa/policy`).pipe(Effect.flatMap(value => decode(Mfa, value))),
  ], { concurrency: 3 });
  const save = (path: string, body: object, notice: string, method = "PUT") => context.run(
    request(`${api}/${path}`, method, body),
    () => { setFlash(notice); context.refresh(); },
  );
  const form = (submit: string, fields: HTMLElement[], changed: (data: FormData) => void) => {
    const root = node("form", { class: "form", method: "post" }, ...fields, node("button", { type: "submit", class: "primary" }, submit));
    root.addEventListener("submit", event => { event.preventDefault(); changed(new FormData(root)); });
    return root;
  };
  const text = (name: keyof typeof passkeys, label: string, value: string) => node("label", {}, label, node("input", { name, value, required: "" }));
  const names = [...new Set(["usernamePassword", "emailPassword", "usernamePasskey", ...methods.enabled])];
  const methodForm = form("Save methods", names.map(name => node("label", { class: "checkbox-field" },
    node("input", { name: "method", type: "checkbox", value: name, ...(methods.enabled.includes(name) ? { checked: "" } : {}) }), name)),
  data => save("methods/settings", { enabled: data.getAll("method"), expectedRevision: methods.revision }, "Sign-in methods saved."));
  const passkeyForm = form("Save passkey settings", [
    text("rpId", "Relying-party ID", passkeys.rpId),
    text("rpName", "Relying-party name", passkeys.rpName),
    text("origins", "Allowed origins, comma-separated", passkeys.origins.join(", ")),
  ], data => save("passkeys/settings", {
    rpId: String(data.get("rpId") ?? ""), rpName: String(data.get("rpName") ?? ""),
    origins: String(data.get("origins") ?? "").split(",").map(origin => origin.trim()).filter(Boolean),
  }, "Passkey settings saved."));
  const policyForm = form("Save MFA policy", [node("label", {}, "Require MFA for", node("select", { name: "requiredFor" },
    ...([["none", "No accounts"], ["privileged", "Privileged accounts"], ["all", "All accounts"]] as const).map(([value, label]) =>
      node("option", { value, ...(value === policy.requiredFor ? { selected: "" } : {}) }, label))))],
  data => save("mfa/policy", { requiredFor: data.get("requiredFor"), expectedRevision: policy.revision }, "MFA policy saved."));
  return [
    flashNotice("Auth settings"),
    card("Sign-in methods", methodForm), card("Passkeys", passkeyForm), card("Multi-factor authentication", policyForm),
    card("Signing keys", button("Rotate signing key", () => save("keys/rotate", {}, "Signing key rotated.", "POST"))),
  ];
});
