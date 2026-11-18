import { Effect } from "effect";
import { isAccountPath } from "../src/account-routes.ts";
import { accountScreen } from "./account-pages.ts";
import { publicAuthScreen } from "./auth-public.ts";
import type { AuthContext } from "./auth-form.ts";
import { message } from "./dom.ts";

const main = document.querySelector<HTMLElement>("main[data-api][data-path][data-mount]");
const api = main?.dataset.api;
const path = main?.dataset.path;
const mount = main?.dataset.mount;

if (main && api && path && mount !== undefined) {
  const render = () => {
    const controller = new AbortController();
    window.addEventListener("pagehide", () => controller.abort(), { once: true });
    const navigate = (next: string) => location.assign(next === "/" ? "/" : `${mount}${next}`);
    const showError = (error: { message: string }) => main.append(message(error.message, true));
    const context: AuthContext = {
      api, path, mount, prefix: `${api}/`, site: true, navigate,
      run: (work, onSuccess) => {
        const controls = Array.from(main.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        controls.forEach(control => { control.disabled = true; });
        Effect.runFork(work.pipe(
          Effect.ensuring(Effect.sync(() => { controls.forEach(control => { control.disabled = false; }); })),
          Effect.tap(value => Effect.sync(() => onSuccess?.(value))),
          Effect.catch(error => Effect.sync(() => showError(error))),
        ), { signal: controller.signal });
      },
    };
    const returnTo = new URL(location.href).searchParams.get("returnTo");
    const account = isAccountPath(path);
    Effect.runFork(Effect.gen(function* () {
      const screen = account
        ? yield* accountScreen(context)
        : yield* publicAuthScreen({ ...context, destination: returnTo && isAccountPath(returnTo) ? returnTo : "/" });
      main.replaceChildren(screen);
      yield* Effect.never;
    }).pipe(Effect.scoped, Effect.catch(error => Effect.sync(() => {
      if (account && error.status === 401) navigate(`/login?returnTo=${encodeURIComponent(path)}`);
      else showError(error);
    }))), { signal: controller.signal });
  };
  render();
  window.addEventListener("pageshow", event => { if (event.persisted) render(); });
}
