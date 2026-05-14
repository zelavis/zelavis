import type { H3 } from "h3";
import { h3Adapter as bindH3Runtime } from "@zelavis/server/adapters/h3";
import type { ZelavisAdapterBinding, ZelavisAdapterPlatform } from "../index.js";
import { defineAdapter } from "../index.js";
import { createLazyBoundValue } from "./_shared.js";

export interface ZelavisH3AdapterOptions {
  platform?: ZelavisAdapterPlatform;
}

export interface ZelavisH3Binding extends ZelavisAdapterBinding {
  h3Handler(): Parameters<H3["use"]>[0];
}

export function h3Adapter(options: ZelavisH3AdapterOptions = {}) {
  return defineAdapter<ZelavisH3Binding>({
    name: "h3",
    platform: options.platform,
    mount: ({ getRuntime }) => {
      const getHandler = createLazyBoundValue(async () =>
        bindH3Runtime(await getRuntime()),
      );

      return {
        async ready() {
          await getHandler();
        },
        h3Handler() {
          return (async (event, next) => {
            const handler = await getHandler();
            return (handler as any)(event, next);
          }) as Parameters<H3["use"]>[0];
        },
      };
    },
  });
}
