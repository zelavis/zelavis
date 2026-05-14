import { defineAdapter } from "../index.js";

export function zelavisFetch() {
  return defineAdapter({ name: "fetch" });
}
