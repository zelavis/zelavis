import {
  definePlugin,
  type ZelavisPluginSetupContext,
} from "zelavis/plugin";
import { defineService } from "@zelavis/server";

export const zelavisEcommercePlugin = definePlugin<ZelavisPluginSetupContext>({
  name: "zelavis-ecommerce",
  version: "0.1.0",
  menu: {
    title: "Ecommerce",
    path: "/commerce",
    pageLabel: "Commerce",
    items: [
      {
        title: "Products",
        path: "/commerce/products",
      },
      {
        title: "Orders",
        path: "/commerce/orders",
      },
      {
        title: "More",
        items: [
          {
            title: "Customers",
            path: "/commerce/customers",
          },
          {
            title: "Coupons",
            path: "/commerce/coupons",
          },
        ],
      },
    ],
  },
  setup(context) {
    return {
      services: [
        defineService({
          name: "commerce",
          service: {
            plugin: context.plugin.name,
          },
          api: {
            v1: [
              {
                id: "commerce.health",
                method: "GET",
                path: "/health",
                handler: () => ({
                  status: 200,
                  body: {
                    plugin: context.plugin.name,
                    rootPath: context.rootPath,
                    apiBasePath: context.api.basePath,
                    platform: {
                      presets: context.platform.presets,
                      resources: context.platform.resources,
                    },
                  },
                }),
              },
            ],
          },
        }),
      ],
    };
  },
});

export const plugin = zelavisEcommercePlugin;
export default zelavisEcommercePlugin;
