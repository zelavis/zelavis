import { Zelavis } from "zelavis";

const zelavis = new Zelavis();

export function getZelavisRuntime() {
  return zelavis.runtime();
}
