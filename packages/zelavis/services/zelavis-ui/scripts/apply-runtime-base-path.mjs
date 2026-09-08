/**
 * Makes the built dashboard mount-agnostic.
 *
 * React Router bakes its `basename` into `window.__reactRouterContext` in the
 * served HTML, so a build was tied to the path it was built for. The Platform
 * used to patch that literal with a regex on the way out, which meant the
 * dashboard could be *supplied* by an installation but never installed at a
 * path of someone's choosing — the one thing a frontend manifest could not
 * express.
 *
 * This appends a small script that reads the mount path the Platform declares
 * through `frontend.basePathGlobal` and applies it before hydration. It is a
 * The basename carries no trailing slash: React Router requires the URL to
 * start with it, and `/zelavis/` does not match a request for `/zelavis`,
 * which renders nothing at all. It is a classic script, so it runs during
 * parsing — ahead of the deferred module
 * that hydrates. With no global present the build behaves exactly as built,
 * which is what `react-router dev` and a bare `/` deployment want.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const BASE_PATH_GLOBAL = "__ZELAVIS_BASE_PATH__";
const MARKER = "zelavis-runtime-base-path";

const patch = `<script data-${MARKER}>(function(){try{var base=window[${JSON.stringify(
  BASE_PATH_GLOBAL,
)}];if(typeof base!=="string"||!base)return;var normalized=base==="/"?"/":"/"+base.replace(/^\\/+|\\/+$/g,"");var context=window.__reactRouterContext;if(context)context.basename=normalized;}catch(error){}})();</script>`;

const indexPath = join("build", "client", "index.html");
const html = await readFile(indexPath, "utf8");

if (html.includes(`data-${MARKER}`)) {
  process.exit(0);
}

if (!html.includes("</body>")) {
  throw new Error(
    `${indexPath} has no </body>; the runtime base path script has nowhere to go.`,
  );
}

// Appended at the end of the body: `window.__reactRouterContext` is assigned
// by an earlier inline script, so patching any sooner would write to nothing.
await writeFile(indexPath, html.replace("</body>", `${patch}</body>`), "utf8");
