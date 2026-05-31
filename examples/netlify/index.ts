import { getStore } from "@netlify/blobs";
import { Zelavis } from "zelavis";
import { netlifyAdapter } from "zelavis/adapters/netlify";

const zv = new Zelavis({
  adapter: netlifyAdapter({
    kv: {
      blobsStore: getStore("zelavis-kv"),
    },
    files: {
      blobsStore: getStore("zelavis-files"),
    },
  }),
});

export default async function handler(request: Request): Promise<Response> {
  return zv.fetch(request);
}
