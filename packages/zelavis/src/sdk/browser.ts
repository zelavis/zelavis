export * from "./fetch.js";
export {
  createZelavisClient as createBrowserZelavisClient,
  fetchSdkSurface as browserSdkSurface,
  zelavis,
  default,
} from "./fetch.js";

export * from "./auth-oauth.js";
export * from "./auth-passkeys.js";
export { type AuthTokenStorage, type BrowserAuthSessionOptions, withAuthLock } from "./auth-session.js";

export const browser = true;
