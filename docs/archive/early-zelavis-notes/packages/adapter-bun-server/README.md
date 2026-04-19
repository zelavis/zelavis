# @zelavis/adapter-bun-server

Bun server adapter for Zelavis - a full platform with storage, API, and optional UI.

## Installation

```bash
bun add @zelavis/adapter-bun-server
```

## Usage

```typescript
import { Zelavis } from "zelavis";
import { adapter_bun_server } from "@zelavis/adapter-bun-server";

const { app, storage_driver } = adapter_bun_server();
const db = new Zelavis(app, storage_driver);

export default {
  port: 3000,
  fetch: app.fetch,
};
```

## License

MIT
