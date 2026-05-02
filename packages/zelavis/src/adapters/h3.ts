import type { H3 } from "h3";
import { h3Adapter as bindH3Runtime } from "@zelavis/server/adapters/h3";
import type { ZelavisAdapterBinding } from "../index.js";
import { createLazyBoundValue, createRuntimeBackedAdapter } from "./_shared.js";

export interface ZelavisH3Binding extends ZelavisAdapterBinding {
  h3Handler(): Parameters<H3["use"]>[0];
}

export function h3Adapter() {
  return createRuntimeBackedAdapter<ZelavisH3Binding>("h3", ({ getRuntime }) => {
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
  });
}
