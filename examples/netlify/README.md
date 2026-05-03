This example shows a small Netlify-oriented fetch handler using `netlifyPlatform()`.

## What it demonstrates

- Netlify Blobs used for platform KV
- Netlify Blobs used for platform file storage
- dashboard settings persisting through platform KV
- website pages and the storage core service persisting through platform file storage

## Key file

- `index.ts` wires `getStore("zelavis-kv")` and `getStore("zelavis-files")` into `netlifyPlatform()`

## Notes

- This example is intentionally minimal and centered on the platform contract.
- In a real Netlify site you would place the handler in the location your chosen Netlify runtime expects.
