# @zelavis/plugin-ecommerce

Official ecommerce marketplace plugin for `zelavis`.

This package is the Zelavis-team plugin that marketplace users install for the
`Ecommerce` workspace area. It uses the high-level Zelavis `definePlugin(...)`
contract and is distinct from lower-level provider plugins inside
`@zelavis/ecommerce`.

## Scope

- declares the official `zelavis-ecommerce` runtime plugin
- owns the Workspace menu metadata for Commerce
- mounts the current commerce runtime stub service
- serves as the first-party marketplace/plugin example for Zelavis

## Important boundary

- `@zelavis/plugin-ecommerce` is a Zelavis marketplace/runtime plugin
- `@zelavis/ecommerce` remains the lower-level domain package
- payment providers such as Stripe and PayPal stay lower-level ecommerce
  provider plugins, not top-level Zelavis marketplace plugins

## Usage

```ts
import { zelavisEcommercePlugin } from "@zelavis/plugin-ecommerce";
import { createPluginRegistry } from "zelavis";

const registry = createPluginRegistry([
  {
    plugin: zelavisEcommercePlugin,
    status: "available",
    source: "official",
    order: 0,
  },
]);
```

Most applications will not import this package manually. Zelavis loads it into
the default official plugin registry automatically.
