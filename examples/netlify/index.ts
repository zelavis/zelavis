import { getStore } from "@netlify/blobs";
import { Zelavis } from "zelavis";
import { netlifyPlatform } from "zelavis/platforms/netlify";

const zelavis = new Zelavis({
  platform: netlifyPlatform({
    kv: {
      blobsStore: getStore("zelavis-kv"),
    },
    files: {
      blobsStore: getStore("zelavis-files"),
    },
  }),
});

export default async function handler(request: Request): Promise<Response> {
  return zelavis.fetch(request);
}
