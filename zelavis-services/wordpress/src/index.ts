/**
 * Official Zelavis WordPress Project recipe.
 *
 * A Project recipe (`kind: "app"`) that ships its own runtime: its
 * `package.json` declares `zelavis.project.runtime`, and `./runtime.ts`
 * provisions and supervises the native Nginx + PHP-FPM + MariaDB stack for each
 * Project. The Platform hard-codes none of it. It freezes this package into the
 * Project, verifies the digest, and only loads the runtime when the host has
 * been told a recipe may provide one (the marketplace allow-list vouches for
 * this one).
 *
 * Nothing is mounted into the Platform, and WordPress Projects use the managed
 * hosting-style navigation, so there is no menu to register.
 */
export { WORDPRESS_APP_NAME } from "./runtime.js";

export function register() {}
