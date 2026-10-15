/**
 * Where the dashboard is mounted, as the code that runs sees it.
 *
 * The build compiles the dashboard against a placeholder root (`/__zelavis__`), and the frontend adapter
 * (`src/frontend.ts`) replaces it with the Platform's real `rootPath` while serving, so one build mounts anywhere
 * (`/zelavis`, `/admin`, `/`; at `/` the root is the empty string). The dev server and the unit tests have no
 * adapter in front of them and use `/zelavis`, the Platform's default.
 */
declare const __ZELAVIS_ROOT__: string | undefined;

/** The mount path without a trailing slash: `/zelavis`, `""` at the origin root, or the build placeholder. */
export const ROOT: string = typeof __ZELAVIS_ROOT__ === "string" ? __ZELAVIS_ROOT__ : "/zelavis";

/** Where the Platform API of this mount starts; the dashboard calls the Platform it is mounted on, `v1` of it. */
export const API_PREFIX = `${ROOT}/api/`;

/** A dashboard route as a document path under the mount: `/` is `ROOT/`. */
export const mounted = (path: string): string => `${ROOT}${path === "/" ? "/" : path}`;

const mountPrefix = new RegExp(`^${ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|$)`);

/** Removes the mount from a pathname, leaving any trailing slash: `ROOT/projects/x/` is `/projects/x/`. */
export const stripMount = (pathname: string): string => pathname.replace(mountPrefix, "");

/** The dashboard route a pathname names: the mount and any trailing slashes removed, `/` for the root. */
export const unmounted = (pathname: string): string => stripMount(pathname).replace(/\/+$/, "") || "/";
