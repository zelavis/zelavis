import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Effect } from "effect";
import { totp, DEFAULT_DIGITS, DEFAULT_PERIOD, DEFAULT_ALGORITHM } from "../../../dist/auth/totp/totp.js";

const exact = name => ({ name, exact: true });
const click = (page, title) => page.getByRole("button", exact(title)).click();
const feedback = (page, text) => page.getByText(text, { exact: true }).waitFor();
const accountNav = page => page.getByRole("navigation", exact("Account"));
const loginPath = url => url.pathname.endsWith("/login");
const signedIn = (url, base) => url.pathname === "/" || url.href === base + "/" || url.href === base + "/projects";
const currentAccountLink = (page, label) => accountNav(page).getByRole("link", exact(label)).and(page.locator('[aria-current="page"]'));

async function accountPage(page, base, path, label) {
  await page.goto(base + "/account" + path);
  await currentAccountLink(page, label).waitFor();
  assert.ok(await page.locator(".account-page").evaluate(element => element.scrollWidth <= element.clientWidth + 1),
    `${path} stays within the workspace at ${page.viewportSize().width}px`);
}

async function qualifyPasskeys(page, base, name) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
    protocol: "ctap2", transport: "internal", hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto(base + "/sign-up");
  await page.locator("input[name=identifier]").fill(name);
  await click(page, "Create account with a passkey");
  await page.waitForURL(url => signedIn(url, base));
  await accountPage(page, base, "/passkeys", "Passkeys");

  const first = page.locator(".account-list li").first();
  await first.getByLabel("Passkey name", { exact: true }).fill("Travel key");
  await first.getByRole("button", exact("Rename")).click();
  await feedback(page, "Passkey renamed.");
  await first.getByText("Travel key", { exact: true }).waitFor();
  await first.getByRole("button", exact("Remove passkey")).click();
  await feedback(page, "You need another passkey to confirm removal.");

  // The server has already verified the first proof. Switch virtual devices
  // before create() so the authenticator does not hold an excluded credential.
  await page.exposeFunction("switchVirtualPasskeyDevice", async () => {
    const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
    assert.equal(credentials.length, 1);
    await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: credentials[0].credentialId });
  });
  await page.evaluate(() => {
    const fetchFromBrowser = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await fetchFromBrowser(...args);
      if (response.ok && new URL(response.url).pathname.endsWith("/auth/passkeys/add/verify")) await window.switchVirtualPasskeyDevice();
      return response;
    };
  });
  await click(page, "Add passkey");
  await feedback(page, "Passkey added.");
  await page.getByRole("button", exact("Remove passkey")).nth(1).waitFor();
  await page.locator(".account-list li").filter({ hasText: "Travel key" }).getByRole("button", exact("Remove passkey")).click();
  await feedback(page, "Passkey removed.");
  await page.getByText("Travel key", { exact: true }).waitFor({ state: "detached" });
  await accountPage(page, base, "/passkeys", "Passkeys");
  assert.equal(await page.getByRole("button", exact("Remove passkey")).count(), 1);
}

async function qualifyEmailAndPassword(page, { base, site, password, name, emailLink }) {
  const browser = page.context().browser();
  const email = `${name}@example.test`;
  const add = `${name}-add@example.test`;
  const primary = `${name}-primary@example.test`;
  const auth = base + "/api/v1/auth";
  await page.goto(base + "/account/emails");
  await page.waitForURL(loginPath);
  assert.equal(new URL(page.url()).searchParams.get("returnTo"), "/account/emails");
  await page.goto(base + "/sign-up");
  await page.locator("input[name=identifier]").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password", { exact: true }).fill(password);
  await click(page, "Create account");
  await feedback(page, "Check your email for a verification link.");
  await page.goto(await emailLink(email, "/verify-email"));
  await page.waitForURL(url => signedIn(url, base));

  if (site) {
    await page.goto(base + "/login");
    await page.getByRole("link", exact("Manage account")).click();
  } else {
    await page.getByRole("navigation", exact("Sidebar view switches")).getByRole("button", exact("Account")).click();
    await page.getByRole("link", exact("Account overview")).click();
  }
  await currentAccountLink(page, "Overview").waitFor();
  await accountNav(page).getByRole("link", exact("Passkeys")).click();
  await page.getByText(/Adding a first passkey needs confirmation/).waitFor();
  await accountNav(page).getByRole("link", exact("Email addresses")).click();
  await page.getByRole("listitem").filter({ hasText: email }).getByText("Primary", { exact: true }).waitFor();
  await page.getByLabel("Email address to add", { exact: true }).fill(add);
  await click(page, "Send verification link");
  await feedback(page, "Check your email for a verification link. Open it in this tab.");
  const addLink = await emailLink(add, "/verify-email");
  const wrongTab = await browser.newPage({ ignoreHTTPSErrors: site });
  try {
    await wrongTab.goto(addLink);
    await wrongTab.getByText(/Open the link in the tab that requested it/).waitFor();
  } finally {
    await wrongTab.close();
  }
  await page.goto(addLink);
  await click(page, "Verify email address");
  await feedback(page, "Email address added.");
  assert.equal(new URL(page.url()).hash, "");
  await page.getByRole("link", exact("Back to email addresses")).click();
  await feedback(page, add);

  await page.getByLabel("New primary email address", { exact: true }).fill(primary);
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await click(page, "Send change email link");
  await feedback(page, "Check your email for a verification link. Open it in this tab.");
  await page.goto(await emailLink(primary, "/change-email"));
  await click(page, "Confirm new primary email");
  await feedback(page, "Primary email changed.");
  assert.equal(new URL(page.url()).hash, "");
  await page.getByRole("link", exact("Back to email addresses")).click();
  await page.getByRole("listitem").filter({ hasText: primary }).getByText("Primary", { exact: true }).waitFor();
  assert.equal(await page.getByText(email, { exact: true }).count(), 0);

  const otherSession = async () => {
    const { status, body } = await page.evaluate(async ({ auth, email, secret }) => {
      const response = await fetch(auth + "/email-password/sign-in", {
        method: "POST", credentials: "omit",
        headers: { "content-type": "application/json", "x-zelavis-auth-mode": "bearer" },
        body: JSON.stringify({ email, password: secret }),
      });
      return { status: response.status, body: await response.json() };
    }, { auth, email: primary, secret: password });
    assert.equal(status, 200, body.error);
    return () => page.evaluate(async ({ auth, accessToken }) => {
      const response = await fetch(auth + "/session", {
        credentials: "omit", headers: { authorization: `Bearer ${accessToken}` },
      });
      return response.status;
    }, { auth, accessToken: body.tokens.accessToken });
  };

  const others = [await otherSession(), await otherSession()];
  await accountPage(page, base, "/sessions", "Sessions");
  await feedback(page, "Current session");
  const revoke = page.getByRole("button", exact("Revoke session"));
  await revoke.nth(1).waitFor();
  await revoke.first().click();
  await feedback(page, "Session revoked.");
  assert.deepEqual((await Promise.all(others.map(session => session()))).sort(), [200, 401]);
  await revoke.nth(1).waitFor({ state: "detached" });
  await click(page, "Revoke all other sessions");
  await feedback(page, "Revoked 1 other session.");
  for (const session of others) assert.equal(await session(), 401);
  await feedback(page, "Current session");

  const newPassword = randomBytes(24).toString("base64url");
  await accountPage(page, base, "/password", "Password");
  await page.getByLabel("Current password", { exact: true }).fill(password);
  await page.getByLabel("New password", { exact: true }).fill(newPassword);
  await page.getByLabel("Confirm new password", { exact: true }).fill(password);
  await click(page, "Change password");
  await feedback(page, "The passwords do not match.");
  await page.getByLabel("Confirm new password", { exact: true }).fill(newPassword);
  await click(page, "Change password");
  await feedback(page, "Password changed.");
  // Enrollment verifies the updated password against the stored credential.
  return newPassword;
}

async function qualifyMfa(page, base, password, site) {
  await accountPage(page, base, "/two-factor", "Two-factor authentication");
  await page.getByLabel("Current password (if you use one)", { exact: true }).fill(password);
  await click(page, "Set up authenticator");
  const setup = page.getByRole("region", exact("Authenticator setup"));
  await setup.getByRole("img", exact("Authenticator setup QR code")).waitFor();
  const uri = await setup.locator("code").last().innerText();
  assert.match(uri, /^otpauth:\/\/totp\//u);
  const secret = new URL(uri).searchParams.get("secret");
  const code = await Effect.runPromise(totp({ secret, digits: DEFAULT_DIGITS, period: DEFAULT_PERIOD, algorithm: DEFAULT_ALGORITHM }, Date.now()));
  await page.getByLabel("New authenticator code", { exact: true }).fill(code);
  await click(page, "Confirm authenticator");
  await feedback(page, "Authenticator added.");
  await setup.waitFor({ state: "detached" });
  const newCodes = page.getByRole("region", exact("New backup codes"));
  const first = (await newCodes.locator("pre").innerText()).split("\n");
  assert.ok(first.length > 1);
  await click(page, "Done");
  await newCodes.waitFor({ state: "detached" });
  const replace = page.getByRole("form", exact("Generate new backup codes"));
  await replace.getByLabel("Authenticator or backup code", { exact: true }).fill(first[0]);
  await replace.getByRole("button", exact("Generate new backup codes")).click();
  await feedback(page, "Backup codes replaced.");
  const replacement = (await newCodes.locator("pre").innerText()).split("\n");
  assert.notEqual(replacement[0], first[0]);
  await accountNav(page).getByRole("link", exact("Sessions")).click();
  await feedback(page, "Current session");
  await page.goBack();
  await page.getByRole("form", exact("Remove authenticator 1")).waitFor();
  assert.equal(await newCodes.count(), 0);
  assert.equal(await setup.count(), 0);
  const remove = page.getByRole("form", exact("Remove authenticator 1"));
  await remove.getByLabel("Authenticator or backup code", { exact: true }).fill(replacement[0]);
  await remove.getByRole("button", exact("Remove authenticator")).click();
  await feedback(page, "Authenticator removed.");
  await feedback(page, "No authenticator is set up.");

  await accountPage(page, base, "/sessions", "Sessions");
  const draftKey = "zelavis:new-ui:drafts:1:account-qualification";
  if (!site) await page.evaluate(key => sessionStorage.setItem(key, "qualification"), draftKey);
  await click(page, "Sign out of this session");
  await page.waitForURL(loginPath);
  if (!site) assert.equal(await page.evaluate(key => sessionStorage.getItem(key), draftKey), null);
}

export async function qualifyAccountPages(browser, { base, site, password, emailLink, errors }) {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const kind = site ? "app" : "platform";
    const name = `manage-${kind}-${viewport.width}`;
    const options = { viewport, ignoreHTTPSErrors: site };
    for (const [label, flow] of [
      ["passkeys", page => qualifyPasskeys(page, base, name)],
      ["email, password, sessions and MFA", async page => {
        const changed = await qualifyEmailAndPassword(page, { base, site, password, name, emailLink });
        await qualifyMfa(page, base, changed, site);
      }],
    ]) {
      const page = await browser.newPage(options);
      page.on("pageerror", error => errors.push(error.message));
      try {
        await flow(page);
      } catch (cause) {
        const url = new URL(page.url());
        const status = await page.locator("[data-feedback] [role=alert]").allTextContents();
        throw new Error(`${kind} account ${label} at ${viewport.width}px, ${url.pathname}: ${status.join(" ")}`, { cause });
      } finally {
        await page.close();
      }
    }
  }
  console.log(`${site ? "App" : "Platform"} account pages: passkeys, two-factor, email, password and sessions passed at both sizes.`);
}
