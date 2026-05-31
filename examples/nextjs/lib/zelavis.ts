import { Zelavis } from "zelavis";

const zv = new Zelavis();

export function getZelavisRuntime() {
  return zv.runtime();
}
