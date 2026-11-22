import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

export const qualificationEmail = "qualification@example.test";
export const qualificationUsername = "qualification-owner";
export const qualificationPassword = "disposable qualification password 2026";
export const qualificationSessionFile = "/var/lib/zelavis/qualification-session";
const qualificationOwnerModeFile = "/var/lib/zelavis/qualification-owner-mode";
const api = "/zelavis/api/v1/auth";

function cookies(response) {
  return response.headers.getSetCookie().map(value => value.split(";", 1)[0]).join("; ");
}

async function readJson(response, status, action) {
  // A failed assertion must not print a successful response's session credentials.
  assert.equal(response.status, status, action);
  return response.json();
}

async function call(baseUrl, path, body, cookie) {
  return fetch(baseUrl + api + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: baseUrl, ...(body === undefined ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function readClaimedOwnerMode() {
  const value = await readFile(qualificationOwnerModeFile, "utf8").catch(() => "");
  return value.trim() === "username" ? "username" : "email";
}

export async function claimQualificationOwner(baseUrl, bootstrapToken) {
  const status = await readJson(await call(baseUrl, "/bootstrap"), 200, "Read first-owner status");
  const candidate = Array.isArray(status.methods);
  const email = qualificationEmail;
  const password = qualificationPassword;
  const response = await call(baseUrl, "/bootstrap", candidate
    ? { bootstrapToken, username: qualificationUsername, password }
    : { bootstrapToken, provider: "password", account: { email }, credential: { identifier: email, password } });
  await readJson(response, 201, "Bootstrap the disposable first owner");
  const cookie = cookies(response);
  assert.ok(cookie, "Bootstrap sets a session cookie");
  await writeFile(qualificationSessionFile, cookie, { mode: 0o600 });
  await writeFile(qualificationOwnerModeFile, candidate ? "username\n" : "email\n", { mode: 0o644 });
  return cookie;
}

export async function signInQualificationOwner(baseUrl, { email, password = qualificationPassword } = {}) {
  const status = await readJson(await call(baseUrl, "/bootstrap"), 200, "Read installed engine's first-owner status");
  const candidate = Array.isArray(status.methods);
  const resolvedEmail = email !== undefined
    ? email
    : candidate && (await readClaimedOwnerMode()) === "username"
      ? ""
      : qualificationEmail;
  const response = await call(baseUrl, candidate
    ? resolvedEmail ? "/email-password/sign-in" : "/username-password/sign-in"
    : "/authenticate/password", candidate
    ? resolvedEmail ? { email: resolvedEmail, password } : { username: qualificationUsername, password }
    : { identifier: resolvedEmail || qualificationEmail, password });
  const signed = await readJson(response, 200, "Sign in to the installed engine");
  if (candidate) assert.equal(signed.status, "complete", "The migrated owner completes sign-in");
  const cookie = cookies(response);
  assert.ok(cookie, "Sign-in sets a session cookie");
  const access = await fetch(baseUrl + "/zelavis/api/v1/runtime/access", { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
  await readJson(access, 200, "Signed-in owner reaches runtime access");
  return cookie;
}

export async function rotateQualificationOwner(baseUrl, cookie) {
  const response = await call(baseUrl, "/session/refresh", {}, cookie);
  const refreshed = await readJson(response, 200, "Rotate the qualification owner's session");
  assert.equal(refreshed.kind, "rotated");
  const next = cookies(response);
  assert.ok(next, "Refresh sets new session cookies");
  await writeFile(qualificationSessionFile, next, { mode: 0o600 });
  return next;
}

export async function refreshQualificationOwner(baseUrl) {
  const cookie = await readFile(qualificationSessionFile, "utf8");
  const status = await call(baseUrl, "/session", undefined, cookie);
  if (status.ok) {
    await status.body?.cancel();
    return cookie;
  }
  await status.body?.cancel();
  const next = await signInQualificationOwner(baseUrl);
  await writeFile(qualificationSessionFile, next, { mode: 0o600 });
  return next;
}
