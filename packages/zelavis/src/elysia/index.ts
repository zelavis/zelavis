import { elysiaAdapter as bindElysiaRuntime } from "@zelavis/server/adapters/elysia";
import type { Zelavis } from "../index.js";

export async function elysiaPlugin(zelavis: Zelavis) {
  const runtime = await zelavis.runtime();
  return bindElysiaRuntime(runtime);
}
