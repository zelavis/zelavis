import { del, head, list, put } from "@vercel/blob";
import { Zelavis } from "zelavis";
import { zelavisVercel } from "zelavis/adapters";

async function putBlob(
  pathname: string,
  body: string | Uint8Array | ArrayBuffer | Blob | ReadableStream<Uint8Array>,
  options: {
    access: "private" | "public";
    addRandomSuffix?: boolean;
    allowOverwrite?: boolean;
    contentType?: string;
  },
) {
  const normalizedBody =
    body instanceof Uint8Array
      ? new Blob([
          body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
        ])
      : body;

  return put(pathname, normalizedBody, options);
}

const zelavis = new Zelavis({
  adapter: zelavisVercel({
    files: {
      blobStore: {
        del,
        head,
        list,
        put: putBlob,
      },
      access: "private",
    },
  }),
});

export function getZelavis() {
  return zelavis;
}
