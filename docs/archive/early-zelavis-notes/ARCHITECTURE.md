# Architecture overview in Excalidraw

https://excalidraw.com/#json=hsJtP1CpwbGChxB7SK9Oy,BPkGPdI5EDoboYJ6IWF-9A

# Repository Packages

- Packages:
  - @zelavis/core
  - @zelavis/zelavis
  - @zelavis/js-sdk
  - @zelavis/ui

# Package Details

- core:

  - includes the storage layer that can use drivers for node, bun, deno, vercel, cloudflare etc. The storage layer uses for each platform the prefered key-value store depending on what driver it uses for long running servers like Node, Bun & Deno it uses LMDB as kv-store, Serverless is the 100% the same except for the driver, when deploying to Vercel it uses "vercel-kv" and when deploying to Cloudflare, "cloudflare-kv" etc. Developers can write custom storage drivers too.

  - The core database is using the storage layer as core part and depending on the driver the database can run on any platform where JavaScript und even the browser.
