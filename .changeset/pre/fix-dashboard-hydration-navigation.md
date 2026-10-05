---
"zelavis": patch
"@zelavis/ui": patch
---

Fix packaged dashboard hydration by keeping host bootstrap scripts out of the generated head's hydration order and using matching rewritten asset URLs in HTML and modules. Project Open shows loading progress, and runtime resolution releases waiting route loaders on API errors, redirects and cancellation without allowing an earlier navigation to resolve a later one. Production browser coverage now exercises Open and reload on desktop and mobile. Remove stale workspace overrides so React and React DOM use the declared 19.3.0 versions required by the React Router v8 stack.
