---
"@zelavis/ui": patch
---

Build and typecheck the dashboard again. Lexical packages are all on 0.51 and
`@assistant-ui/react` is on 0.15.20, so each family resolves to one copy; the
split upgrades had left two Lexical versions with incompatible types and an
`assistant-cloud` without the `ai-sdk` export the new core imports.
