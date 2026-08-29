---
"@zelavis/ui": patch
---

Upgrade React Router to 8.3.1 as one coordinated bump across `react-router`,
`@react-router/dev`, `@react-router/node`, and `@react-router/serve`, so the
framework packages never sit on split majors.

`UIMatch` no longer carries the deprecated `data` property; only `loaderData`
remains. No application code read it — the field was only set in a test fixture.
