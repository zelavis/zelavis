import { zelavisApp } from "./app/index.js";
import type {
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "./core/index.js";

export const officialProjectRecipes = Object.freeze([
  Object.freeze({
    service: zelavisApp,
    specifier: "zelavis/app",
    status: "available",
    source: "official",
    order: 0,
  }),
]) satisfies readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
