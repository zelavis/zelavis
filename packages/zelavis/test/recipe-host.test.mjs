import test from "node:test";
import { createRecipeHost } from "../dist/adapters/_recipe-host.js";
import { recipeHostConformance } from "./fixtures/recipe-host-conformance.mjs";

recipeHostConformance(test, (options) => createRecipeHost(options));
