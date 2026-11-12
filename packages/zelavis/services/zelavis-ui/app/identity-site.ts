import { Effect } from "effect";
import { request } from "./api.ts";
import { authFormError } from "./auth-form.ts";

const main = document.querySelector<HTMLElement>("main[data-api]");
const form = main?.querySelector<HTMLFormElement>("form[data-operation]");
const button = form?.querySelector("button");
const feedback = form?.querySelector<HTMLElement>("[data-feedback]");
const api = main?.dataset.api;
const operation = form?.dataset.operation;

if (form && button && feedback && api && operation && ["session", "sign-up/password", "authenticate/password"].includes(operation)) {
  const signOut = operation === "session";
  const signup = operation === "sign-up/password";
  button.disabled = false;
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (button.disabled) return;
    const fields = new FormData(form);
    const password = String(fields.get("password") ?? "");
    if (signup && password !== fields.get("confirm")) {
      feedback.textContent = "The passwords do not match.";
      form.querySelector<HTMLInputElement>('[name="confirm"]')?.focus();
      return;
    }
    const displayName = String(fields.get("displayName") ?? "").trim();
    const input = signOut ? undefined : {
      identifier: String(fields.get("identifier") ?? "").trim(), password,
      ...(displayName ? { displayName } : {}),
    };
    feedback.textContent = "";
    button.disabled = true;
    Effect.runFork(request(`${api}/auth/${operation}`, signOut ? "DELETE" : "POST", input, `${api}/`).pipe(
      Effect.tap(() => Effect.sync(() => { if (signOut) location.reload(); else location.assign("/"); })),
      Effect.catch(error => Effect.sync(() => {
        if (signup && error.code === "registration_closed") location.reload();
        else if (signOut && error.status === 401) location.reload();
        else feedback.textContent = authFormError(error);
      })),
      Effect.ensuring(Effect.sync(() => {
        for (const field of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) field.value = "";
        button.disabled = false;
      })),
    ));
  });
}
