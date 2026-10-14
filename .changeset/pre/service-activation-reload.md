---
"zelavis": patch
---

A plugin or frontend installed, updated or uninstalled on a running Platform now takes effect without a restart: the Platform hands traffic to a fresh engine of the same release through the same handover that applies updates, so requests wait briefly instead of failing and no previous code stays loaded. Installing a Project recipe needs no reload; the next Project created or upgraded uses it.
