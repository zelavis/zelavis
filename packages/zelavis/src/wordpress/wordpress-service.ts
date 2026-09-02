/**
 * Official managed WordPress Project recipe.
 *
 * This is a Project recipe implemented by a `kind: "app"` service, not a
 * Zelavis plugin. The local
 * Project runtime recognizes the exact recipe lock and provisions the
 * matching native Nginx + PHP-FPM + MariaDB stack. Keeping the release version here
 * makes new installs reproducible and prevents a Platform update from silently
 * rewriting an existing Project.
 */
export const WORDPRESS_VERSION = "7.1";
export const WORDPRESS_DOWNLOAD_URL =
  `https://wordpress.org/wordpress-${WORDPRESS_VERSION}.tar.gz`;

export const wordpressApp = Object.freeze({
  name: "zelavis/wordpress",
  version: WORDPRESS_VERSION,
  kind: "app",
  capabilities: Object.freeze(["app:project", "app:managed", "app:wordpress"]),
  project: Object.freeze({ runtimeKinds: Object.freeze(["native"] as const) }),
  service: Object.freeze({}),
  api: {},
  marketplace: {
    title: "WordPress",
    summary:
      "A native managed WordPress site with dedicated Nginx, PHP-FPM, and MariaDB instances.",
    categories: ["apps", "cms", "official"],
    tags: ["wordpress", "cms", "php", "mariadb", "native"],
  },
});

export default wordpressApp;
