# @zelavis/adapter-deno-server

Deno server adapter for Zelavis - a full platform with storage, API, and optional UI.

## Installation

```bash
deno add @zelavis/adapter-deno-server
```

## Usage

```typescript
import { Zelavis } from "zelavis";
import { adapter_deno_server } from "@zelavis/adapter-deno-server";

const { app, storage_driver } = adapter_deno_server();
const db = new Zelavis(app, storage_driver);

Deno.serve({ port: 3000 }, app.fetch);
```

## License

MIT
