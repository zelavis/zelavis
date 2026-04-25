import { zelavis } from "zelavis";

const runtimePromise = zelavis({});

export function getZelavisRuntime() {
  return runtimePromise;
}
