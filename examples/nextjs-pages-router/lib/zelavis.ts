import { Zelavis } from "zelavis";
import { zelavisNextjsPagesRouter, zelavisNode } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisNextjsPagesRouter({ platform: zelavisNode() }),
});

export function getZelavisRuntime() {
  return zelavis.runtime();
}

export function getZelavis() {
  return zelavis;
}
