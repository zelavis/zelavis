/**
 * The auth settings page.
 *
 * Deliberately thin. Accounts, sessions, credentials, password verification
 * and the OAuth flow are Zelavis itself — an installation cannot function
 * without them, so they are not something a package provides. What a package
 * can usefully own is the face: a settings page, and a catalogue of the
 * plugins that extend auth.
 *
 * That split is why removing this service is harmless. Sign-in keeps working;
 * you lose the page that configures it, and the endpoints it drives are still
 * there for the CLI and the API. Nothing here is privileged: it contributes a
 * menu and a page through the same extension points any plugin uses, and it
 * reads the same public endpoints anyone else could.
 */
import { zelavis } from "zelavis/sdk";

import { AUTH_SETTINGS_PAGE } from "./page.js";

export const ZELAVIS_AUTH_SETTINGS_SERVICE_NAME = "@zelavis/auth";

/**
 * The capability owner auth extensions declare against.
 *
 * `zelavis/auth`, not this package. Extensions point at the core service that
 * discovers and runs them; this one only shows what is installed for it. The
 * two names are close enough to confuse, and getting it wrong would produce a
 * catalogue nothing ever appears in.
 */
export const AUTH_EXTENSION_OWNER = "zelavis/auth";

zelavis.menu.create({
  title: "Auth",
  path: "/auth",
  pageLabel: "Auth",
  sectionLabel: "Platform",
  order: 20,
  surface: "platform",
  page: {
    id: "auth-settings",
    title: "Auth",
    file: "auth.html",
  },
  access: {
    // The page reads and writes OAuth client credentials and installs
    // plugins, so it is gated the same way those endpoints are rather than
    // being visible to anyone who can open the dashboard.
    permissions: ["system.settings.manage"],
    scope: { type: "system" },
  },
});

export default {
  name: ZELAVIS_AUTH_SETTINGS_SERVICE_NAME,
  basePath: "/auth-settings",
  capabilities: Object.freeze(["dashboard:menu"]),
  marketplace: Object.freeze({
    title: "Auth",
    summary: "Configure sign-in and install auth providers.",
    categories: Object.freeze(["auth"]),
  }),
  pageAssets: {
    "auth.html": {
      contentType: "text/html; charset=utf-8",
      body: AUTH_SETTINGS_PAGE,
    },
  },
  service: {},
};
