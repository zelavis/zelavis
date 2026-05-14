import { getStore } from "@netlify/blobs";
import { Zelavis } from "zelavis";
import { zelavisNetlify } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisNetlify({
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
