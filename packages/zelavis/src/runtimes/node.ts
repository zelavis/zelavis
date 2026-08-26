import type { Server } from "node:http";
import { nodeAdapter as bindNodeRuntime } from "@zelavis/server/adapters/node";
import type { Zelavis } from "../index.js";

export const node = true;

export interface CloseNodeServerOptions {
  gracePeriodMs?: number;
}

export async function createNodeServer(zelavis: Zelavis): Promise<Server> {
  const runtime = await zelavis.runtime();
  return bindNodeRuntime(runtime);
}

export async function closeNodeServer(
  server: Server,
  options: CloseNodeServerOptions = {},
): Promise<void> {
  if (!server.listening) {
    return;
  }

  const gracePeriodMs = Math.max(0, options.gracePeriodMs ?? 10_000);
  await new Promise<void>((resolveClose, rejectClose) => {
    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
    }, gracePeriodMs);

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error) {
        rejectClose(error);
      } else {
        resolveClose();
      }
    });
    server.closeIdleConnections();
  });
}
