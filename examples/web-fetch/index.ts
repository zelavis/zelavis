import { Zelavis } from "zelavis";

// Reference embedding example only.
// This module exports a standard fetch handler for Web-native hosts,
// but it does not start a standalone local server by itself.

const zelavis = new Zelavis();

export interface ZelavisFetchPlatformContext {
  env?: unknown;
  executionContext?: unknown;
}

export async function fetch(
  request: Request,
  context: ZelavisFetchPlatformContext = {},
): Promise<Response> {
  return zelavis.fetch(request, {
    platform: {
      web: context,
    },
  });
}

export default {
  fetch,
};
