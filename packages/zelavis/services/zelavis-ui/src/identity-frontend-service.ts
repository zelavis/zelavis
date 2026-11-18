import { Effect, Schema } from "effect";
import { zelavis } from "zelavis/sdk";
import type { ZelavisPlatformFrontendContext } from "zelavis";
import { mountOf } from "./mount-rewrite.ts";
import { accountPageTitles, isAccountPath } from "./account-routes.ts";

const authPages = {
  ...accountPageTitles,
  "/login": "Login",
  "/sign-up": "Create an account",
  "/forgot-password": "Forgot password",
  "/reset-password": "Reset password",
  "/verify-email": "Verify email",
  "/change-email": "Change primary email",
  "/invitation": "Accept invitation",
  "/mfa": "Verify sign-in",
  "/oauth/callback": "Provider sign-in",
} as const;

export const identityPagePaths = Object.keys(authPages);
const Methods = Schema.Struct({
  registration: Schema.Struct({ enabled: Schema.Boolean }),
  methods: Schema.Array(Schema.Struct({ signUp: Schema.Boolean })),
});
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

function identityDocument(mount: string, api: string, path: string, title: string, fallback: string, closed = false): string {
  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${title}</title><link rel="stylesheet" href="${mount}/auth-assets/identity.css">
    ${closed ? "" : `<script type="module" src="${mount}/auth-assets/identity.js"></script>`}</head>
    <body><main${isAccountPath(path) ? " data-account" : ""} data-api="${api}" data-path="${path}" data-mount="${mount}"><h1>${title}</h1>${fallback}</main></body></html>`;
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
    if (path === undefined || !Object.hasOwn(authPages, path)) return { status: 404, headers: pageHeaders, body: "Not found" };
    const title = authPages[path as keyof typeof authPages];
    const signup = path === "/sign-up";
    let open = false;
    let unavailable = false;
    if (signup || path === "/login") {
      const methods = yield* Effect.result(Effect.gen(function* () {
        const response = yield* Effect.tryPromise({
          try: signal => context.fetch(new Request(new URL(`${api}/auth/methods`, url.origin), { signal })),
          catch: cause => cause,
        });
        if (!response.ok) return yield* Effect.fail(new Error("Auth methods are unavailable."));
        const data = yield* Effect.tryPromise({ try: () => response.json(), catch: cause => cause });
        return yield* Schema.decodeUnknownEffect(Methods)(data);
      }));
      unavailable = methods._tag === "Failure";
      open = methods._tag === "Success" && methods.success.registration.enabled && methods.success.methods.some(method => method.signUp);
    }
    const closed = signup && !open;
    const fallback = path === "/login"
      ? open ? `<a href="${mount}/sign-up">Create account</a>` : ""
      : `<a href="${mount}/login">Back to login</a>`;
    const heading = closed ? unavailable ? "Registration is unavailable" : "Registration is closed" : title;
    return {
      status: closed ? unavailable ? 503 : 404 : 200, headers: pageHeaders,
      body: identityDocument(mount, api, path, heading, fallback, closed),
    };
  }).pipe(Effect.timeout("10 seconds"), Effect.catchCause(cause => Effect.gen(function* () {
    yield* Effect.logWarning("App auth page delivery failed", cause);
    return { status: 503, headers: pageHeaders, body: "Sign-in is temporarily unavailable." };
  }))), { signal: request.signal });

  const apiDefinition = zelavis.createAPI({ shell: { render } }, { routes: false });
  zelavis.frontend.configure({ shell: apiDefinition.shell });
}
