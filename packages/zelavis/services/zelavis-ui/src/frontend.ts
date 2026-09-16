import manifest from "@zelavis/ui/package.json" with { type: "json" };
import { loadPluginPackage } from "zelavis/service";
/**
 * `@zelavis/ui` as a Platform frontend.
 *
 * The Platform does not know this package exists. It accepts a frontend and
 * serves whatever it is given, so this is the adapter that presents the
 * dashboard as one — supplied by whoever composes the installation, and
 * removable without touching the Platform.
 */
import {
  createZelavisDashboardBundleStore,
  defaultZelavisDashboardClientRoutes,
} from "./dashboard-service.js";
import { zelavisServicePageStylesheet } from "./generated/service-page-styles.js";

export interface ZelavisUiFrontendContext {
  readonly rootPath: string;
  readonly title?: string;
  readonly subtitle?: string;
  readonly devServerUrl?: string;
  readonly createRuntimeConfig: () => Promise<unknown>;
}

export async function zelavisUiFrontend(context: ZelavisUiFrontendContext) {
  const dashboardBundleStore = createZelavisDashboardBundleStore(
    context.rootPath,
  );

  return {
    service: await loadPluginPackage({
      manifest,
      scope: "system",
      configuration: context,
      importer: () => import("./dashboard-service.js"),
    }),
    bundleStore: {
      async read(scope: { projectId?: string; serviceName: string; bundle: string }, path: string) {
        return dashboardBundleStore.read(scope, path);
      },
    },
    clientRoutes: defaultZelavisDashboardClientRoutes,
    servicePageStylesheet: zelavisServicePageStylesheet,
  };
}

export default zelavisUiFrontend;
