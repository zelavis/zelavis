import { Effect, Schema } from "effect";
import { decode, request, type ApiError } from "./api.ts";
import { message, node } from "./dom.ts";
import { card } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

const RegistrationSettings = Schema.Struct({ enabled: Schema.Boolean, revision: Schema.Natural });

function unavailable(error: ApiError) {
  return message(error.status === 404
    ? "Registration settings are unavailable. Check that the Project exists and its App engine supports registration settings."
    : error.message, true);
}

export const registrationSettingsCard = Effect.fn("ui.registrationSettingsCard")(function*(context: ScreenContext, projectId: string) {
  const path = `${context.config.api.basePath}/runtime/projects/${encodeURIComponent(projectId)}/auth/registration/settings`;
  const read = request(path).pipe(Effect.flatMap(value => decode(RegistrationSettings, value)));
  const initial = yield* Effect.result(read);
  if (initial._tag === "Failure") return card("Public registration", unavailable(initial.failure));

  let settings = initial.success;
  const enabled = node("input", { type: "checkbox" });
  const save = node("button", { type: "submit", class: "primary", disabled: "" }, "Save");
  const status = node("div", { role: "status", class: "muted" });
  const show = (current: typeof settings, notice: string) => {
    settings = current;
    enabled.checked = current.enabled;
    enabled.disabled = false;
    save.disabled = true;
    status.textContent = notice;
  };
  show(settings, settings.enabled ? "Registration is open." : "Registration is closed.");
  enabled.addEventListener("change", () => { save.disabled = enabled.checked === settings.enabled; });
  const form = node("form", { class: "form" },
    node("label", { class: "checkbox-field" }, enabled, "Allow public registration"), save, status);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (save.disabled) return;
    enabled.disabled = true;
    save.disabled = true;
    const input = { enabled: enabled.checked, expectedRevision: settings.revision };
    const update = Effect.gen(function* () {
      const result = yield* Effect.result(request(path, "PUT", input).pipe(
        Effect.flatMap(value => decode(RegistrationSettings, value))));
      if (result._tag === "Success") {
        return { settings: result.success, notice: result.success.enabled ? "Registration opened." : "Registration closed." };
      }
      const current = yield* Effect.result(read);
      if (current._tag === "Failure") return { error: current.failure };
      return {
        settings: current.success,
        notice: result.failure.code === "registration_settings_conflict"
          ? "Registration settings changed. Review the current setting and try again."
          : result.failure.message,
      };
    });
    context.run(update, result => {
      if (result.error) form.replaceChildren(unavailable(result.error));
      else show(result.settings, result.notice);
    });
  });
  return card("Public registration", form);
});
