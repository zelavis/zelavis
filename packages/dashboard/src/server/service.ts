import { defineServerService, type ZelavisServerService } from "@zelavis/server";
import type { DashboardDefinition, DashboardServiceOptions, DashboardView } from "../contracts.js";
import { createDefaultDashboardDefinition } from "../defaults.js";
import { renderDashboardDocument } from "../render.js";
import { defaultDashboardStyles } from "../styles.js";

function buildDefinition(options: DashboardServiceOptions = {}): DashboardDefinition {
  const defaults = createDefaultDashboardDefinition();

  return {
    title: options.title ?? defaults.title,
    subtitle: options.subtitle ?? defaults.subtitle,
    assetPath: options.assetPath ?? defaults.assetPath,
    views: options.views ?? defaults.views,
  };
}

function getViewBySlug(definition: DashboardDefinition, slug: string): DashboardView | undefined {
  return definition.views.find((view) => view.slug === slug);
}

function htmlResponse(body: string) {
  return {
    status: 200,
    body,
    headers: {
      "content-type": "text/html; charset=utf-8",
    },
  };
}

function cssResponse(body: string) {
  return {
    status: 200,
    body,
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  };
}

export function createDashboardService(
  options: DashboardServiceOptions = {},
): ZelavisServerService<DashboardDefinition> {
  const definition = buildDefinition(options);
  const overview = getViewBySlug(definition, "");

  if (!overview) {
    throw new Error("Dashboard definition must include an overview view with an empty slug.");
  }

  return defineServerService({
    name: "dashboard",
    basePath: options.basePath ?? "/dashboard",
    service: definition,
    api: {
      v1: [
        {
          id: "dashboard.view.overview",
          method: "GET",
          path: "/",
          handler: ({ service }) => htmlResponse(renderDashboardDocument(service, overview)),
        },
        {
          id: "dashboard.view.customers",
          method: "GET",
          path: "/customers",
          handler: ({ service }) => {
            const view = getViewBySlug(service, "customers");
            if (!view) {
              throw new Error('Dashboard view "customers" is not registered.');
            }

            return htmlResponse(renderDashboardDocument(service, view));
          },
        },
        {
          id: "dashboard.view.orders",
          method: "GET",
          path: "/orders",
          handler: ({ service }) => {
            const view = getViewBySlug(service, "orders");
            if (!view) {
              throw new Error('Dashboard view "orders" is not registered.');
            }

            return htmlResponse(renderDashboardDocument(service, view));
          },
        },
        {
          id: "dashboard.view.system",
          method: "GET",
          path: "/system",
          handler: ({ service }) => {
            const view = getViewBySlug(service, "system");
            if (!view) {
              throw new Error('Dashboard view "system" is not registered.');
            }

            return htmlResponse(renderDashboardDocument(service, view));
          },
        },
        {
          id: "dashboard.assets.styles",
          method: "GET",
          path: "/assets/dashboard.css",
          handler: () => cssResponse(defaultDashboardStyles),
        },
      ],
    },
  });
}

export function dashboardService(
  options: DashboardServiceOptions = {},
): ZelavisServerService<DashboardDefinition> {
  return createDashboardService(options);
}
