# Early Zelavis Notes

This archive preserves markdown and MDX material from an earlier prototype so its ideas are not lost before that folder is removed.

The content has been mechanically normalized to Zelavis naming. It should not be treated as current package documentation or as a promise of future APIs.

## Contents

- `ARCHITECTURE.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`: early project governance and package-structure notes.
- `docs/src/content/docs/advanced/json-api.mdx`: JSON API design notes.
- `docs/src/content/docs/guides/file-storage.mdx` and `packages/zelavis/docs/FILE_STORAGE.md`: file metadata, blob storage, offline sync, and HTTP route ideas.
- `docs/src/content/docs/reference/transactions.md`: transaction API and behavior notes.
- `packages/zelavis/docs/replication-load-balancing.md`: replication, clustering, routing, and consistency notes.
- `packages/adapter-*`: runtime adapter notes for Bun, Deno, Node, Web, and Workers-style distributions.
- `packages/zelavis-ui` and `examples/*`: dashboard and example-app notes.

## Migration Rules

- Prefer extracting contracts, terminology, and design constraints over copying implementation.
- Keep core packages framework-agnostic.
- Keep storage, files, replication, UI, and transport as separate package or adapter concerns.
- Do not add heavy dependencies unless a package genuinely needs them.
- Update current package READMEs only after a design is implemented in the active source tree.
