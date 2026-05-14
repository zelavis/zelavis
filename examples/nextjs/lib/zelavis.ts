import { Zelavis } from "zelavis";
import { zelavisFetch } from "zelavis/adapters";

const zelavis = new Zelavis({
  adapter: zelavisFetch(),
});

export function getZelavisRuntime() {
  return zelavis.runtime();
}
