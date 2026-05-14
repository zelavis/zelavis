import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zelavis = new Zelavis({
  adapter: nodeAdapter(),
});

export function getZelavis() {
  return zelavis;
}

export function getZelavisRuntime() {
  return zelavis.runtime();
}
