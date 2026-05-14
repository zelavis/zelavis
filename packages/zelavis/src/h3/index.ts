import type { H3 } from "h3";
import { h3Adapter as bindH3Runtime } from "@zelavis/server/adapters/h3";
import type { Zelavis } from "../index.js";

export function h3Handler(zelavis: Zelavis): Parameters<H3["use"]>[0] {
  let handler: ReturnType<typeof bindH3Runtime> | undefined;
  return (async (event, next) => {
    if (!handler) {
      const runtime = await zelavis.runtime();
      handler = bindH3Runtime(runtime);
    }
    return (handler as any)(event, next);
  }) as Parameters<H3["use"]>[0];
}
