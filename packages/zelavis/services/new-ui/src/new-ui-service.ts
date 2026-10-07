import { zelavis } from "zelavis/sdk";
import type { ZelavisPlatformFrontendContext } from "zelavis";

export function register(context: ZelavisPlatformFrontendContext) {
  if (context.rootPath !== "/zelavis") throw new Error("The experimental dashboard currently mounts at /zelavis.");
  let handler: ((request: Request) => Promise<Response>) | undefined;
  const render = async ({ request }: { request: Request }) => {
    try {
      handler ??= (await import(new URL("../dist-spa-server/server/entry.mjs", import.meta.url).href)).handler;
      const response = await handler!(request);
      return { status: response.status, headers: Object.fromEntries(response.headers), body: response.body ?? undefined };
    } catch {
      return { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }, body: "Run pnpm --filter @zelavis/new-ui build:fuzor first." };
    }
  };
  const api = zelavis.createAPI({ shell: { render } }, { routes: false });
  zelavis.plugins.ui.menus.create({ title: "Dashboard", path: "/", surface: "root" });
  zelavis.frontend.configure({ shell: api.shell, devUrl: context.devServerUrl, devUrlExcludePaths: ["api"] });
}
