export const accountPageTitles = {
  "/account": "Account",
  "/account/passkeys": "Passkeys",
  "/account/two-factor": "Two-factor authentication",
  "/account/emails": "Email addresses",
  "/account/password": "Password",
  "/account/sessions": "Sessions",
} as const;

export type AccountPath = keyof typeof accountPageTitles;
export const isAccountPath = (path: string): path is AccountPath => Object.hasOwn(accountPageTitles, path);
