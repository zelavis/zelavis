import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

export const zv = new Zelavis({
  adapter: nodeAdapter(),
});
