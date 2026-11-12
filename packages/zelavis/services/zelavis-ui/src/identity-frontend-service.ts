import { Effect, Schema } from "effect";
import { RegistrationStatusSchema } from "zelavis/app/identity";
import { zelavis } from "zelavis/sdk";
import type { ZelavisPlatformFrontendContext } from "zelavis";
import { mountOf } from "./mount-rewrite.ts";

export const identityPagePaths = ["/login", "/sign-up"] as const;
export const identityAssets = {
  "/auth-assets/identity.js": { file: "identity.js", type: "text/javascript; charset=utf-8" },
  "/auth-assets/identity.css": { file: "identity.css", type: "text/css; charset=utf-8" },
} as const;

const pageHeaders = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function field(label: string, name: string, attributes: string): string {
  return `<label>${label}<input name="${name}" ${attributes}></label>`;
}

export function register({ context, assets }: {
  context: ZelavisPlatformFrontendContext;
  assets: ReadonlyMap<string, { body: Uint8Array; type: string }>;
}) {
  const mount = mountOf(context.rootPath);
  const api = context.apiBasePath;
  if (![mount, api].every(path => /^(?:\/[\w~.-]+)*$/u.test(path) && !/\/\.\.?(?:\/|$)/u.test(path))) {
    throw new Error("Invalid App auth mount.");
  }
  const render = ({ request, path }: { request: Request; path?: string }) => Effect.runPromise(Effect.gen(function* () {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== `${mount}${path}`) {
      return { status: 404, headers: pageHeaders, body: "Not found" };
    }
    const asset = path && assets.get(path);
    if (asset) return { status: 200, headers: { ...pageHeaders, "content-type": asset.type }, body: asset.body };
    if (path !== "/login" && path !== "/sign-up") return { status: 404, headers: pageHeaders, body: "Not found" };

    const signup = path === "/sign-up";
    const probe = (suffix: string, headers?: HeadersInit) => Effect.tryPromise({
      try: signal => context.fetch(new Request(new URL(`${api}/auth/${suffix}`, url.origin), { signal, headers })),
      catch: cause => cause,
    });
    const registration = yield* probe("registration").pipe(
      Effect.flatMap(response => Effect.tryPromise({ try: () => response.json() as Promise<unknown>, catch: cause => cause }).pipe(
        Effect.flatMap(body => response.ok ? Schema.decodeUnknownEffect(RegistrationStatusSchema)(body) : Effect.fail(new Error("Registration status is unavailable."))),
      )),
      Effect.result,
    );
    const available = registration._tag === "Success" && registration.success.enabled && registration.success.providers.includes("password");
    const cookie = request.headers.get("cookie");
    const session = !signup && cookie ? yield* probe("session", { cookie }).pipe(
      Effect.tap(response => Effect.tryPromise({ try: () => response.body?.cancel() ?? Promise.resolve(), catch: cause => cause })),
      Effect.result,
    ) : undefined;
    const signedIn = session?._tag === "Success" && session.success.ok;

    const loginLink = `<a href="${mount}/login">${signup ? "Back to login" : "Login"}</a>`;
    const closed = signup && !available;
    const unavailable = signup && registration._tag === "Failure";
    const title = unavailable ? "Registration is unavailable" : closed ? "Registration is closed" : signup ? "Create an account" : signedIn ? "You're signed in" : "Login";
    const passwordAttributes = `type="password" autocomplete="${signup ? "new-password" : "current-password"}" ${signup ? 'minlength="15" ' : ""}maxlength="1024" required`;
    const feedback = '<p role="status" aria-live="polite" data-feedback></p>';
    const form = closed ? loginLink : signedIn
      ? `<a href="/">Continue to site</a><form method="post" data-operation="session">${feedback}<button disabled>Sign out</button></form>`
      : `<form method="post" data-operation="${signup ? "sign-up/password" : "authenticate/password"}">
          ${field("Email or username", "identifier", 'autocomplete="username" maxlength="254" required')}
          ${signup ? field("Display name (optional)", "displayName", 'autocomplete="name" maxlength="120"') : ""}
          ${field("Password", "password", passwordAttributes)}
          ${signup ? field("Confirm password", "confirm", passwordAttributes) : ""}
          ${feedback}<button disabled>${signup ? "Create account" : "Login"}</button></form>
          ${signup ? loginLink : available ? `<a href="${mount}/sign-up">Create account</a>` : ""}`;

    return { status: unavailable ? 503 : closed ? 404 : 200, headers: pageHeaders, body: `<!doctype html>
      <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>${title}</title><link rel="stylesheet" href="${mount}/auth-assets/identity.css">
      ${closed ? "" : `<script type="module" src="${mount}/auth-assets/identity.js"></script>`}</head>
      <body><main data-api="${api}"><h1>${title}</h1>${form}</main></body></html>` };
  }).pipe(Effect.timeout("10 seconds"), Effect.catchCause(cause => Effect.gen(function* () {
    yield* Effect.logWarning("App auth page delivery failed", cause);
    return { status: 503, headers: pageHeaders, body: "Sign-in is temporarily unavailable." };
  }))), { signal: request.signal });

  const apiDefinition = zelavis.createAPI({ shell: { render } }, { routes: false });
  zelavis.frontend.configure({ shell: apiDefinition.shell });
}
