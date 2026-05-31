import { Zelavis } from "zelavis";
import { nodeAdapter } from "zelavis/adapters/node";

export const zelavis = new Zelavis({
  adapter: nodeAdapter(),
});
