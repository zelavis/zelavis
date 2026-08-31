import { zelavisApp } from "./app/index.js";
import { wordpressApp } from "./wordpress/index.js";
import type {
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "./service.js";

export const officialProjectRecipes = Object.freeze([
  Object.freeze({
    service: zelavisApp,
    specifier: "zelavis/app",
    status: "available",
    source: "official",
    order: 0,
  }),
  Object.freeze({
    service: wordpressApp,
    specifier: "zelavis/wordpress",
    status: "available",
    source: "official",
    order: 10,
  }),
]) satisfies readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
