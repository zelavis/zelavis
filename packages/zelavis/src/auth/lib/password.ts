// Derived from Convex Auth (https://github.com/convex/convex-auth), packages/core/src/lib/password.ts
// at a8b5d9a2ebc8b733b510b7c1f46558af6ef21fce. Copyright 2026 Convex, Inc.
// Licensed under the Apache License, Version 2.0; see packages/zelavis/LICENSE-APACHE.
// Modified for Zelavis: the minimum length is 15 characters, as Zelavis required before (upstream: 10).
// TODO: Make the minimum length an option of each method (for example
// `setupUsernamePassword`). Today all methods enforce 15 (upstream: 10).
/**
 * The minimum length of a new password in the password methods. The methods
 * export it (`zelavis/auth`), so that a sign-up
 * form can show the same limit as the backend.
 *
 * The password component accepts shorter passwords (`MIN_PASSWORD_LENGTH` of
 * `components/password/validation.ts`). Thus the methods give this value to
 * `validateNewPassword`.
 */
export const DEFAULT_MIN_PASSWORD_LENGTH = 15;
