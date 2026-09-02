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
  createZelavisDashboardService,
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

export function zelavisUiFrontend(context: ZelavisUiFrontendContext) {
  const dashboardBundleStore = createZelavisDashboardBundleStore(
    context.rootPath,
  );

  return {
    service: createZelavisDashboardService({
      ...(context.title ? { title: context.title } : {}),
      ...(context.subtitle ? { subtitle: context.subtitle } : {}),
      rootPath: context.rootPath,
      ...(context.devServerUrl ? { devServerUrl: context.devServerUrl } : {}),
      createRuntimeConfig: context.createRuntimeConfig,
    }) as never,
    bundleStore: {
      async read(scope: never, path: string) {
        return dashboardBundleStore.read(scope, path);
      },
    },
    clientRoutes: defaultZelavisDashboardClientRoutes,
    servicePageStylesheet: zelavisServicePageStylesheet,
  };
}

export default zelavisUiFrontend;
