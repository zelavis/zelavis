/**
 * Official Zelavis TYPO3 Project recipe.
 *
 * A Project recipe (`kind: "app"`) that ships its own runtime: `package.json` declares
 * `zelavis.project.runtime`, and `./runtime.ts` is the Platform's recipe runtime over `./recipe.ts`.
 * TYPO3 Projects use the managed hosting-style navigation, so there is no menu to register.
 */
export { TYPO3_APP_NAME } from "./runtime.js";

export function register() {}
