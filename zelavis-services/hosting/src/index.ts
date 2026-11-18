import { registerHostingMenu } from "./hosting-plugin.js";

export type { HostingPlan } from "./plans.js";
export type { HostingSubscription } from "./subscriptions.js";
export { hostingPlugin as default, hostingPlugin } from "./hosting-plugin.js";

export function register(): void {
  registerHostingMenu();
}
