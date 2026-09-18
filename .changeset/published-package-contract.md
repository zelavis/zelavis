---
"zelavis": patch
---

Verify what a consumer actually receives from `npm install zelavis`.

Every existing test imports `../dist/...` directly, so the suite passes whether
or not those files were ever published. The package has 35 export subpaths,
each promising a JavaScript entry and a type declaration, and nothing checked
that they still lead anywhere in the tarball.

This packs the real artifact and works only with what comes out of it: every
`exports` target and its `.d.ts` is present, everything `files` promises
shipped, the package loads in a bare consumer with only its declared
dependencies, the runtime-neutral subpaths load without the optional database
engines, and the published `bin` runs.

The DB engine subpaths are deliberately excluded from the load checks: their
engines are peer dependencies, so failing to import them without an install is
correct behaviour rather than a defect.
