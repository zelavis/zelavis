import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The dashboard requires a real Platform session: `/runtime/access` returns 401
 * without one and the client never hydrates. This setup bootstraps (or signs in
 * as) the first owner against the runtime origin and persists the resulting
 * session cookie as Playwright storage state.
 *
 * Cookies are scoped by host, not port, so the cookie issued by the runtime on
 * 127.0.0.1:3000 is also sent to the dashboard dev server on 127.0.0.1:3100,
 * which proxies `/zelavis/api` back to the runtime.
 */
const runtimeOrigin =
  process.env.ZELAVIS_E2E_RUNTIME_ORIGIN ?? "http://127.0.0.1:3000";
const bootstrapToken = process.env.ZELAVIS_BOOTSTRAP_TOKEN;
const ownerEmail = process.env.ZELAVIS_E2E_OWNER_EMAIL ?? "ci@example.com";
// Never defaulted: a checked-in password would be a credential-shaped literal,
// and a wrong default would fail as "invalid credentials" rather than as the
// configuration mistake it is.
const ownerPassword = process.env.ZELAVIS_E2E_OWNER_PASSWORD;

export const storageStatePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../test-results/storage-state.json",
);

const authBase = `${runtimeOrigin}/zelavis/api/v1/auth`;

async function postJson(url: string, body: unknown) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: runtimeOrigin },
    body: JSON.stringify(body),
  });
}

function sessionCookieFrom(response: Response): string | undefined {
  const header = response.headers.get("set-cookie");
  return header?.match(/zelavis_session=([^;]+)/)?.[1];
}

async function resolveSessionToken(): Promise<string> {
  if (!ownerPassword) {
    throw new Error(
      "ZELAVIS_E2E_OWNER_PASSWORD is required to sign the dashboard e2e owner in. " +
        "CI generates it per run; set it yourself to run these tests locally.",
    );
  }

  const status = await fetch(`${authBase}/bootstrap`).then((r) =>
    r.ok ? r.json() : undefined,
  );

  if (status?.required) {
    if (!bootstrapToken) {
      throw new Error(
        "The runtime needs first-owner bootstrap but ZELAVIS_BOOTSTRAP_TOKEN is not set.",
      );
    }

    const created = await postJson(`${authBase}/bootstrap`, {
      bootstrapToken,
      provider: "password",
      account: { email: ownerEmail, displayName: "Zelavis E2E" },
      credential: { identifier: ownerEmail, password: ownerPassword },
    });

    if (!created.ok) {
      throw new Error(
        `First-owner bootstrap failed (${created.status}): ${await created.text()}`,
      );
    }

    const cookie = sessionCookieFrom(created);
    if (cookie) return cookie;
    return (await created.json()).session.token;
  }

  const signedIn = await postJson(`${authBase}/authenticate/password`, {
    identifier: ownerEmail,
    password: ownerPassword,
  });

  if (!signedIn.ok) {
    throw new Error(
      `E2E owner sign-in failed (${signedIn.status}): ${await signedIn.text()}`,
    );
  }

  const cookie = sessionCookieFrom(signedIn);
  if (cookie) return cookie;
  return (await signedIn.json()).session.token;
}

export default async function globalSetup() {
  const token = await resolveSessionToken();

  await mkdir(dirname(storageStatePath), { recursive: true });
  await writeFile(
    storageStatePath,
    JSON.stringify({
      cookies: [
        {
          name: "zelavis_session",
          value: token,
          domain: "127.0.0.1",
          path: "/zelavis",
          expires: Math.floor(Date.now() / 1000) + 60 * 60,
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    }),
  );
}
