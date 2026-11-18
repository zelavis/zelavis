// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/methods/username-passkey/purposes.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: Added attribution and adjusted relative import paths where needed.
/** The re-authentication that signs a user in. */
export const SIGN_IN_PURPOSE = "usernamePasskey:signIn";

/** The re-authentication that comes before a user adds a passkey. */
export const ADD_PASSKEY_PURPOSE = "usernamePasskey:addPasskey";

/** The re-authentication that authorizes the removal of a passkey. */
export const REMOVE_PASSKEY_PURPOSE = "usernamePasskey:removePasskey";
