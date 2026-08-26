import { zelavisApp } from "@zelavis/app";
import type {
  ZelavisServiceRegistryEntry,
  ZelavisServiceSetupContext,
} from "@zelavis/server";

export const officialProjectRecipes = Object.freeze([
  Object.freeze({
    service: zelavisApp,
    specifier: "@zelavis/app",
    status: "available",
    source: "official",
    order: 0,
  }),
]) satisfies readonly ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>[];
