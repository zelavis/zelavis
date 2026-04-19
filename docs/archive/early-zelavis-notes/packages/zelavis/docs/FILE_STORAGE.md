# File Storage Implementation

Complete offline-first file storage system for Zelavis with unstorage.

## Features Implemented

✅ **Unified File Storage API** - Upload, download, delete, list files  
✅ **Offline-First** - IndexedDB in browser, auto-sync when online  
✅ **Multiple Storage Backends** - Memory, filesystem, S3, R2, etc.  
✅ **Schema Types** - `s.fileRef()`, `s.image()`, `s.audio()`, `s.video()`, `s.pdf()`, `s.mp3()`, `s.mp4()`, `s.jpg()`, `s.png()`  
✅ **HTTP API** - Upload/download/delete files via REST endpoints  
✅ **Validation** - File size limits, MIME type validation  
✅ **Security** - Checksums for integrity verification  
✅ **Schema Expression Parser** - Works with all file types automatically

## Usage Examples

### 1. Basic File Upload & Download

\`\`\`typescript
const db = new Zelavis({
adapter: adapter_bun_server(),
fileStorage: {
driver: 'memory', // or 'fs', 's3', 'r2', 'indexeddb'
maxFileSize: 10_000_000, // 10MB
allowedMimeTypes: ['image/jpeg', 'image/png', 'audio/mpeg']
}
});

// Upload file
const buffer = await file.arrayBuffer();
const metadata = await db.files.upload(buffer, {
name: 'song.mp3',
mimeType: 'audio/mpeg'
});

console.log(metadata);
// {
// id: 'file-1234...',
// name: 'song.mp3',
// size: 3145728,
// mimeType: 'audio/mpeg',
// uploadedAt: '2025-12-28T...',
// checksum: 'abc123...',
// syncStatus: 'synced'
// }

// Download file
const { buffer: downloadedBuffer, metadata: downloadedMeta } =
await db.files.download(metadata.id);

// Delete file
await db.files.delete(metadata.id);

// List all files
const files = await db.files.list();
\`\`\`

### 2. Collection with File References

\`\`\`typescript
// Create collection with file schema types
await db.createCollection((s) => ({
collectionName: 'songs',
schema: {
title: s.string({ minLength: 1 }),
artist: s.string(),
audio: s.mp3(), // Required MP3 file reference
coverArt: s.jpg({ optional: true }), // Optional JPG reference
duration: s.number({ min: 0 })
}
}));

// Upload files first
const audioBuffer = await fetch('/song.mp3').then(r => r.arrayBuffer());
const audioMeta = await db.files.upload(audioBuffer, {
name: 'my-song.mp3',
mimeType: 'audio/mpeg'
});

const coverBuffer = await fetch('/cover.jpg').then(r => r.arrayBuffer());
const coverMeta = await db.files.upload(coverBuffer, {
name: 'cover.jpg',
mimeType: 'image/jpeg'
});

// Insert document with file references
await db.insert(() => ({
into: 'songs',
values: {
title: 'My Song',
artist: 'John Doe',
audio: {
id: audioMeta.id,
name: audioMeta.name,
url: db.files.getUrl(audioMeta.id),
size: audioMeta.size,
mimeType: audioMeta.mimeType,
uploadedAt: audioMeta.uploadedAt
},
coverArt: {
id: coverMeta.id,
name: coverMeta.name,
url: db.files.getUrl(coverMeta.id),
size: coverMeta.size,
mimeType: coverMeta.mimeType,
uploadedAt: coverMeta.uploadedAt
},
duration: 180
}
}));
\`\`\`

### 3. HTTP API (JSON)

\`\`\`bash

# Upload file

curl -X POST http://localhost:3000/zelavis/api/files/upload \\
-F "file=@song.mp3"

# Response:

{
"status": "ok",
"file": {
"id": "file-1234...",
"url": "/zelavis/files/file-1234...",
"name": "song.mp3",
"size": 3145728,
"mimeType": "audio/mpeg",
"uploadedAt": "2025-12-28T..."
}
}

# Download file

curl http://localhost:3000/zelavis/files/file-1234...

# Get metadata

curl http://localhost:3000/zelavis/api/files/file-1234.../metadata

# Delete file

curl -X DELETE http://localhost:3000/zelavis/api/files/file-1234...

# List all files

curl http://localhost:3000/zelavis/api/files
\`\`\`

### 4. Schema Expressions (JSON API)

\`\`\`json
POST /zelavis/api/json/create-collection
{
"collectionName": "media",
"schemaExpressions": {
"title": "s.string()",
"coverImage": "s.image({ optional: true })",
"audioFile": "s.mp3()",
"videoFile": "s.mp4({ optional: true })",
"document": "s.pdf({ optional: true })"
}
}
\`\`\`

### 5. All Available File Schema Types

\`\`\`typescript
// Generic file reference
s.fileRef(opts?: { mimeTypes?: string[], maxSize?: number, optional?: boolean })

// Specialized types
s.image(opts?) // image/jpeg, image/png, image/gif, image/webp
s.audio(opts?) // audio/mpeg, audio/mp3, audio/wav, audio/ogg
s.video(opts?) // video/mp4, video/webm, video/ogg
s.pdf(opts?) // application/pdf

// Specific formats
s.mp3(opts?) // audio/mpeg
s.mp4(opts?) // video/mp4
s.jpg(opts?) // image/jpeg
s.png(opts?) // image/png
\`\`\`

### 6. Offline Sync (Browser)

\`\`\`typescript
// In browser, files automatically stored in IndexedDB
const db = new Zelavis({
adapter: adapter_browser(),
fileStorage: {
driver: 'indexeddb',
enableOfflineSync: true,
syncEndpoint: 'https://api.myapp.com/zelavis/api/files/sync'
}
});

// Upload while offline - stored locally with syncStatus: 'pending'
const metadata = await db.files.upload(buffer, {
name: 'photo.jpg',
mimeType: 'image/jpeg'
});

// When online, automatically syncs to server
// syncStatus changes to 'synced'
\`\`\`

### 7. Production Configuration

\`\`\`typescript
// Development: Local filesystem
const db = new Zelavis({
adapter: adapter_bun_server(),
fileStorage: {
driver: 'fs',
driverOptions: {
base: './uploads'
}
}
});

// Production: AWS S3
const db = new Zelavis({
adapter: adapter_bun_server(),
fileStorage: {
driver: 's3',
driverOptions: {
bucket: 'my-bucket',
accessKeyId: process.env.AWS_ACCESS_KEY,
secretAccessKey: process.env.AWS_SECRET_KEY,
endpoint: 'https://s3.amazonaws.com',
publicUrl: 'https://cdn.myapp.com'
}
}
});

// Production: Cloudflare R2
const db = new Zelavis({
adapter: adapter_cloudflare_workers(),
fileStorage: {
driver: 'r2',
driverOptions: {
binding: env.MY_BUCKET, // Cloudflare Worker binding
publicUrl: 'https://files.myapp.com'
}
}
});
\`\`\`

## Architecture

\`\`\`
┌─────────────────────────────────────────────────────────┐
│ Zelavis.files API │
├─────────────────────────────────────────────────────────┤
│ upload(buffer, metadata) → FileMetadata │
│ download(id) → { buffer, metadata } │
│ delete(id) → void │
│ list() → FileMetadata[] │
│ getMetadata(id) → FileMetadata │
│ getUrl(id) → string │
└─────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────┐
│ FileStorage Class │
├─────────────────────────────────────────────────────────┤
│ - Validation (size, MIME type) │
│ - Checksums (SHA-256) │
│ - Offline sync queue │
│ - Auto-sync on online event │
└─────────────────────────────────────────────────────────┘
↓
┌─────────────────────────────────────────────────────────┐
│ unstorage (unified API) │
├─────────────────────────────────────────────────────────┤
│ Browser: IndexedDB | Memory │
│ Server: Filesystem | S3 | R2 | Memory │
└─────────────────────────────────────────────────────────┘
\`\`\`

## File Reference Schema Structure

Documents store file **references**, not actual file data:

\`\`\`typescript
interface FileReference {
id: string; // File ID in storage
name: string; // Original filename
url: string; // URL to access file
size: number; // Size in bytes
mimeType: string; // MIME type
uploadedAt: string; // ISO 8601 timestamp
}
\`\`\`

This keeps documents lightweight and queryable while files are stored separately in blob storage.

## HTTP Endpoints Added

- `POST /zelavis/api/files/upload` - Upload file
- `GET /zelavis/files/:id` - Download file
- `GET /zelavis/api/files/:id/metadata` - Get file metadata
- `DELETE /zelavis/api/files/:id` - Delete file
- `GET /zelavis/api/files` - List all files
- `POST /zelavis/api/files/sync` - Sync offline files (browser → server)

## Files Created/Modified

### New Files

- `packages/zelavis/src/storage/file-storage.ts` - FileStorage class
- `packages/zelavis/tests/file-storage.test.ts` - 17 tests (all passing)

### Modified Files

- `packages/zelavis/src/new_zelavis.ts`
  - Added FileStorage integration
  - Added 9 file schema types (fileRef, image, audio, video, pdf, mp3, mp4, jpg, png)
- `packages/zelavis/src/http/routes.ts`
  - Added 6 file operation endpoints

### Unchanged (Already Compatible)

- `packages/zelavis/src/schema-expression-parser.ts` - Works automatically with new types

## Test Results

All 59 tests pass:

- 15 schema expression parser tests ✅
- 18 schema validation tests ✅
- 3 server startup tests ✅
- 6 JSON API tests ✅
- 17 file storage tests ✅

## Next Steps (Optional Enhancements)

1. **Image Processing** - Add thumbnail generation, resizing
2. **Video Processing** - Generate previews, extract metadata
3. **Compression** - Auto-compress files before storage
4. **CDN Integration** - Auto-upload to CDN for public files
5. **Storage Quotas** - Per-user or per-collection file limits
6. **Virus Scanning** - Integrate ClamAV or similar
7. **Direct Upload** - Generate signed URLs for client → S3 direct upload

## Summary

The file storage system is production-ready with:

- ✅ Universal storage (browser + server)
- ✅ Offline-first with auto-sync
- ✅ Multiple storage backends
- ✅ Type-safe schemas
- ✅ Complete HTTP API
- ✅ Comprehensive tests
- ✅ Zero breaking changes to existing code
