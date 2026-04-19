# @zelavis/adapter-web

Web browser file storage adapter for Zelavis - provides IndexedDB-based file storage for browser environments.

## Features

- 🗄️ **IndexedDB Storage**: Persistent file storage in the browser
- 🔄 **Offline-first**: Files available without network connection
- 📦 **Lightweight**: Minimal dependencies
- 🚀 **Zero config**: Works with sensible defaults

## Installation

```bash
npm install @zelavis/adapter-web
# or
bun add @zelavis/adapter-web
# or
pnpm add @zelavis/adapter-web
```

## Usage

```typescript
import { Zelavis } from "zelavis";
import { adapter_web } from "@zelavis/adapter-web";

const db = new Zelavis({
  adapter: myClientAdapter, // Your client/server adapter
  fileStorage: adapter_web(), // IndexedDB for files
});

await db.connect();

// Upload and store files in IndexedDB
const file = new File(["content"], "document.pdf");
const fileRef = await db.files.upload(file);

// Access files offline
const url = db.files.getUrl(fileRef.id);
```

## Options

```typescript
interface AdapterWebOptions {
  /**
   * IndexedDB database name for file storage
   * @default "zelavis-files"
   */
  indexedDbName?: string;
}
```

### Custom IndexedDB Name

```typescript
const fileStorage = adapter_web({
  indexedDbName: "my-app-files",
});
```

## How It Works

This adapter configures the file storage layer of Zelavis to use IndexedDB for storing file blobs. It's meant to be used alongside a client or server adapter:

- **With server adapter**: For self-hosted databases with browser file storage
- **With client adapter**: For remote databases with local file caching

## Browser Compatibility

- Chrome/Edge: ✅ Full support
- Firefox: ✅ Full support
- Safari: ✅ Full support (iOS 10+)
- Opera: ✅ Full support

Requires IndexedDB support.

## License

MIT
