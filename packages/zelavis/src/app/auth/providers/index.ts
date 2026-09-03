/**
 * Credential providers Zelavis ships with.
 *
 * Password sign-in and the OAuth Authorization Code client live here rather
 * than in plugins. Both are ceremonies whose dangerous parts are generic —
 * password verification and its timing, and the state, nonce and PKCE custody
 * a redirect flow depends on — so they are written and audited once. What is
 * vendor-specific stays a plugin: an identity provider's endpoints and claim
 * shapes are declared through `zelavis/auth:oauth`.
 */
export * from "./password.js";
export * from "./oauth-contract.js";
export * from "./oauth-connections.js";
export * from "./oauth-flow.js";
export * from "./oauth-definitions.js";
export * from "./oauth-discovery.js";
