export * from "./stripe-service.js";
import { stripeService, registerStripeMenu } from "./stripe-service.js";
const plugin = stripeService();
export default { service: plugin.service, setup: plugin.setup };
/** SDK declarations run for every package load, including cached modules. */
export function register(): void { registerStripeMenu(); }
