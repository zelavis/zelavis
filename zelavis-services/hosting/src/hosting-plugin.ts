import type { EcommerceApi } from "@zelavis/ecommerce";
import { Effect } from "effect";
import { zelavis } from "zelavis/sdk";
import type { ZelavisServiceSetupContext } from "zelavis/service";
import { accountAccess } from "./accounts.js";
import { hostingStore, isDatabase, platformClient, platformFailure, unavailable, type HostingError } from "./runtime.js";
import { hostingPlans } from "./plans.js";
import { hostingSettings } from "./settings.js";
import { hostingSubscriptions } from "./subscriptions.js";
import { hostingProvisions } from "./provisions.js";
import { hostingEntitlements } from "./entitlements.js";
import { hostingWorker } from "./worker.js";

export function createHostingPlugin({ now = Date.now, workerIntervalMs }: {
  readonly now?: () => number;
  readonly workerIntervalMs?: number;
} = {}) {
  if (workerIntervalMs !== undefined && (!Number.isSafeInteger(workerIntervalMs) || workerIntervalMs < 1)) throw new RangeError("Invalid Hosting worker interval.");
  type Registration = { commerce?: EcommerceApi; subscriptions?: ReturnType<typeof hostingSubscriptions> };
  const registrations = new WeakMap<object, Registration>();
  const registrationFor = (scope: object) => {
    const existing = registrations.get(scope);
    if (existing) return existing;
    const created: Registration = {};
    registrations.set(scope, created);
    return created;
  };
  return {
    service: {
      register(api: EcommerceApi) {
        if (!api?.context?.runtimeScope || typeof api.fulfillment?.registerHandler !== "function" ||
            typeof api.payments?.listProviders !== "function" ||
            typeof api.customers?.getById !== "function" || typeof api.checkouts?.create !== "function") {
          throw new TypeError("Hosting requires the runtime-scoped Ecommerce billing API.");
        }
        const registration = registrationFor(api.context.runtimeScope);
        registration.commerce = api;
        return Effect.runPromise(api.fulfillment.registerHandler("hosting", message =>
          Effect.runPromise(registration.subscriptions?.fulfill(message) ?? Effect.fail(unavailable()))));
      },
    },
    setup(context: ZelavisServiceSetupContext) {
      const registration = registrationFor(context.registry);
      if (!isDatabase(context.core.database) || !context.core.fetch) {
        throw new TypeError("Hosting requires Ecommerce, Platform service storage and an approved service principal.");
      }
      // Registry order is chosen by the host. Ecommerce can register before or after this setup.
      const commerce = () => registration.commerce ? Effect.succeed(registration.commerce) : Effect.fail(unavailable());
      const store = hostingStore(context.core.database);
      const platform = platformClient(context.core.fetch, context.api.basePath);
      const whenApproved = (pass: () => Effect.Effect<void, HostingError>) => Effect.gen(function* () {
        // An embedded host can keep a previously composed instance alive after disable.
        // Check the revocable principal before editing that instance's service state.
        const response = yield* platform("GET", "/auth/roles");
        if (response.status === 401 || response.status === 403) return;
        if (!response.ok) return yield* platformFailure(response.status);
        yield* pass();
      });
      const settings = hostingSettings(store, commerce, now);
      const plans = hostingPlans(store, settings, platform, now);
      const accounts = accountAccess(platform);
      const subscriptions = hostingSubscriptions(store, settings, plans, accounts, commerce, context.rootPath, now);
      const provisions = hostingProvisions(store, plans, subscriptions, accounts, platform, now);
      return Effect.runPromise(Effect.gen(function* () {
        for (const collection of [settings.settings.collection, plans.collection]) yield* store.ensure(collection);
        yield* store.ensure(subscriptions.collection, ["allocatedProjects", "planId", "reviewAfter"]);
        yield* store.ensure(provisions.collection, ["state"]);
        registration.subscriptions = subscriptions;
        const reconcileEntitlements = hostingEntitlements(store, subscriptions, provisions, platform, now);
        context.addRuntimePlugin(hostingWorker("Project and plan", workerIntervalMs ?? 60_000, () =>
          whenApproved(() => plans.reconcile().pipe(Effect.andThen(provisions.reconcile)))));
        context.addRuntimePlugin(hostingWorker("entitlement", workerIntervalMs ?? 300_000, () =>
          whenApproved(reconcileEntitlements)));
        context.addEndpointGroup({
          id: "@zelavis/hosting:api", basePath: "/plugins/hosting", context: {},
          origin: { type: "service", serviceName: context.service.name },
          api: { v1: [...settings.routes, ...plans.routes, ...subscriptions.routes, ...provisions.routes] },
        });
      }));
    },
  };
}

export const hostingPlugin = createHostingPlugin();

export function registerHostingMenu(): void {
  zelavis.plugins.ui.menus.create({
    title: "Hosting Provider",
    path: "/hosting",
    page: { id: "hosting-customer", title: "Hosting Provider", bundle: "dashboard", file: "customer.html" },
    access: { authenticated: true },
    items: [
      { title: "Plans and settings", path: "/hosting/plans", access: { permissions: ["hosting.manage"] },
        page: { id: "hosting-plans", title: "Plans and settings", bundle: "dashboard", file: "plans.html" } },
      { title: "Subscriptions", path: "/hosting/subscriptions", access: { permissions: ["hosting.view"] },
        page: { id: "hosting-subscriptions", title: "Subscriptions", bundle: "dashboard", file: "subscriptions.html" } },
    ],
  });
}
