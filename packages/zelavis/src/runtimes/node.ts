import type { Server } from "node:http";
import { nodeAdapter as bindNodeRuntime } from "@zelavis/server/adapters/node";
import type { Zelavis } from "../index.js";

export const node = true;

export async function createNodeServer(zelavis: Zelavis): Promise<Server> {
  const runtime = await zelavis.runtime();
  return bindNodeRuntime(runtime);
}
