# @zelavis/ecommerce

Official Zelavis ecommerce package.

This package is now the single home for Zelavis ecommerce:

- the official Zelavis runtime plugin `zelavisEcommercePlugin`
- the low-level commerce domain API via `createEcommerce(...)`
- provider extension points such as `defineEcommercePlugin(...)`

There is no separate old ecommerce base package anymore.

## Main entrypoints

- [packages/plugins/ecommerce/src/zelavis-ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/zelavis-ecommerce-plugin.ts)
- [packages/plugins/ecommerce/src/core/create-ecommerce.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/core/create-ecommerce.ts)
- [packages/plugins/ecommerce/src/ecommerce-plugin.ts](/Users/ivanjeremicx/Projects/zelavis/packages/plugins/ecommerce/src/ecommerce-plugin.ts)

## Usage

```ts
import {
  createEcommerce,
  defineEcommercePlugin,
  zelavisEcommercePlugin,
} from "@zelavis/ecommerce";
```

## Included layers

- runtime plugin for the Zelavis marketplace/dashboard/plugin system
- low-level commerce entities, repositories, and services
- provider plugins such as Stripe and PayPal
- optional framework adapters for embedding commerce APIs
