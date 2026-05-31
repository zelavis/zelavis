import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

const zv = new Zelavis({
  adapter: nodeAdapter(),
});

export function getZelavis() {
  return zv;
}

export function getZelavisRuntime() {
  return zv.runtime();
}
