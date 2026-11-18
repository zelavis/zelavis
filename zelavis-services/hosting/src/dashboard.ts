import { Effect } from "effect";
import { createServicePageFetch, isSandboxedServicePage } from "zelavis/sdk/service-page";
import type { HostingPlan } from "./plans.js";
import type { HostingSubscription } from "./subscriptions.js";

class PageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const sandboxed = isSandboxedServicePage();
const normalFetch = createServicePageFetch();
const billingFetch = createServicePageFetch({ offerExternalLink: true });
const apiBase = new URL("../../../../", location.href).pathname.replace(/\/$/u, "");
const api = <A>(path: string, options: { method?: string; body?: unknown; billing?: boolean } = {}) => Effect.gen(function* () {
  const fetch = options.billing ? billingFetch : normalFetch;
  const response = yield* Effect.tryPromise({
    try: signal => fetch(sandboxed ? `hosting/${path}` : `${apiBase}/plugins/hosting/hosting/${path}`, {
      signal, method: options.method ?? "GET",
      headers: { accept: "application/json", ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
    catch: () => new PageError(0, "The dashboard could not reach Hosting Provider."),
  });
  if (response.status === 401) return yield* Effect.fail(new PageError(401, "Sign in again to continue."));
  return yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new PageError(response.status, "Hosting Provider returned an unreadable response."),
  }).pipe(Effect.flatMap((body: A & { message?: string }) => response.ok ? Effect.succeed(body) :
    Effect.fail(new PageError(response.status, typeof body?.message === "string" ? body.message : `Request failed (${response.status}).`))));
});

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing Hosting page element ${id}.`);
  return found as T;
}

const text = <Tag extends keyof HTMLElementTagNameMap>(tag: Tag, value: string) => {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
};
const show = (id: string, value: string, error = false) => {
  const node = element(id);
  node.textContent = value;
  node.classList.toggle("hosting-error", error);
};
const report = (id: string) => (error: PageError) => Effect.sync(() => show(id, error.message, true));
const field = <T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form: HTMLFormElement, name: string) =>
  form.elements.namedItem(name) as T;
const button = (label: string, action: (control: HTMLButtonElement) => void) => {
  const control = text("button", label);
  control.type = "button";
  control.className = "zv-button";
  control.addEventListener("click", () => action(control));
  return control;
};
const option = (value: string, label = value) => new Option(label, value);

function action<A>(status: string, control: HTMLButtonElement, run: Effect.Effect<A, PageError>) {
  control.disabled = true;
  show(status, "");
  Effect.runFork(run.pipe(Effect.catch(report(status)), Effect.ensuring(Effect.sync(() => { control.disabled = false; }))));
}

type Settings = { publicBaseUrl: string; provider: string; graceDays: number };
type SettingsView = { settings: Settings | null; providers: string[] };
type PlansView = { plans: HostingPlan[]; projectPermissions?: string[]; maximumProjects?: number };

function operatorPlans() {
  const settings = element<HTMLFormElement>("settings");
  const form = element<HTMLFormElement>("plan");
  const id = field<HTMLInputElement>(form, "id");
  const maximum = field<HTMLInputElement>(form, "projects");
  let current: HostingPlan | undefined;
  let permissions: string[] = [];

  const displaySettings = ({ settings: value, providers }: SettingsView) => {
    const select = field<HTMLSelectElement>(settings, "provider");
    select.replaceChildren(...providers.map(provider => option(provider)));
    if (value) {
      field(settings, "publicBaseUrl").value = value.publicBaseUrl;
      select.value = value.provider;
      field(settings, "graceDays").value = String(value.graceDays);
    }
    show("settings-status", providers.length ? "" : "Install an Ecommerce payment provider to configure hosting.");
  };
  settings.addEventListener("submit", event => {
    event.preventDefault();
    const control = event.submitter as HTMLButtonElement;
    const data = new FormData(settings);
    action("settings-status", control, api<SettingsView>("settings", { method: "PUT", body: {
      publicBaseUrl: data.get("publicBaseUrl"), provider: data.get("provider"), graceDays: Number(data.get("graceDays")),
    } }).pipe(Effect.tap(view => Effect.sync(() => {
      displaySettings(view);
      show("settings-status", "Settings saved.");
    }))));
  });

  const edit = (plan?: HostingPlan) => {
    current = plan;
    form.reset();
    form.hidden = false;
    element("plan-heading").textContent = plan ? `Edit ${plan.title}` : "New plan";
    id.readOnly = plan !== undefined;
    id.value = plan?.id ?? "";
    field(form, "title").value = plan?.title ?? "";
    field(form, "description").value = plan?.description ?? "";
    field(form, "amount").value = plan ? String(plan.price.amount) : "";
    field(form, "currency").value = plan?.price.currency ?? "usd";
    field(form, "interval").value = plan?.price.interval ?? "month";
    maximum.value = String(plan?.limits.projects ?? 1);
    field(form, "recipes").value = plan?.limits.recipes?.join(", ") ?? "";
    field<HTMLInputElement>(form, "active").checked = plan?.active ?? true;
    element("permissions").replaceChildren(...permissions.map(permission => {
      const label = text("label", permission);
      label.className = "hosting-check";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.name = "permission";
      check.value = permission;
      check.checked = plan ? plan.projectPermissions.includes(permission) : true;
      label.prepend(check);
      return label;
    }));
    show("plan-status", "");
  };

  const loadPlans = () => api<PlansView>("plans").pipe(Effect.tap(view => Effect.sync(() => {
    permissions = view.projectPermissions ?? [];
    maximum.max = String(view.maximumProjects ?? 20);
    element<HTMLButtonElement>("new-plan").disabled = permissions.length === 0;
    const list = element("plans");
    list.replaceChildren(...view.plans.map(plan => {
      const row = document.createElement("li");
      row.className = "hosting-heading";
      row.append(text("span", `${plan.title} · ${plan.limits.projects} Projects · ${plan.active ? "Available" : "Inactive"}`),
        button(`Edit ${plan.title}`, () => edit(plan)));
      return row;
    }));
    show("plans-status", view.plans.length ? "" : "No plans have been created.");
  })));
  element("new-plan").addEventListener("click", () => { edit(); id.focus(); });
  element("close-plan").addEventListener("click", () => { form.hidden = true; });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(form);
    const recipes = String(data.get("recipes")).split(",").map(value => value.trim()).filter(Boolean);
    const description = String(data.get("description")).trim();
    action("plan-status", event.submitter as HTMLButtonElement, Effect.gen(function* () {
      const { plan } = yield* api<{ plan: HostingPlan }>(`plans/${encodeURIComponent(id.value)}`, { method: "PUT", body: {
        title: data.get("title"), ...(description ? { description } : {}),
        price: { amount: Number(data.get("amount")), currency: String(data.get("currency")).toLowerCase(), interval: data.get("interval") },
        limits: { projects: Number(data.get("projects")), ...(recipes.length ? { recipes } : {}) },
        projectPermissions: data.getAll("permission"), active: data.has("active"),
        ...(current ? { updatedAt: current.updatedAt } : {}),
      } });
      edit(plan);
      show("plan-status", "Plan saved.");
      yield* loadPlans().pipe(Effect.catch(report("plans-status")));
    }));
  });
  Effect.runFork(api<SettingsView>("settings").pipe(Effect.tap(view => Effect.sync(() => displaySettings(view))), Effect.catch(report("settings-status"))));
  Effect.runFork(loadPlans().pipe(Effect.catch(report("plans-status"))));
}

const stateLabel = { pending: "Payment pending", active: "Active", past_due: "Past due", suspended: "Suspended" } as const;
const dateLabel = (value: string) => new Date(value).toLocaleString();

function operatorSubscriptions() {
  let after: string | undefined;
  const more = element<HTMLButtonElement>("more");
  const list = element("subscriptions");
  const load = () => Effect.gen(function* () {
    const view = yield* api<{ subscriptions: HostingSubscription[]; next?: string }>(
      `subscriptions${after ? `?after=${encodeURIComponent(after)}` : ""}`);
    for (const item of view.subscriptions) {
      const row = document.createElement("tr");
      row.append(...[item.principalId, item.planId, stateLabel[item.state],
        String(item.billedProjects.length), item.graceEndsAt ? dateLabel(item.graceEndsAt) : "—"].map(value => text("td", value)));
      list.append(row);
    }
    after = view.next;
    more.hidden = !after;
    show("subscriptions-status", list.childElementCount ? "" : "There are no hosting subscriptions.");
  });
  more.addEventListener("click", () => action("subscriptions-status", more, load()));
  Effect.runFork(load().pipe(Effect.catch(report("subscriptions-status"))));
}

const priceLabel = (plan: HostingPlan) => {
  const currency = plan.price.currency.toUpperCase();
  const format = new Intl.NumberFormat(undefined, { style: "currency", currency });
  const amount = plan.price.amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2);
  return `${format.format(amount)} per ${plan.price.interval}`;
};

function customerPage() {
  const form = element<HTMLFormElement>("project");
  const billing = (path: string, body?: object) => Effect.gen(function* () {
    const result = yield* api<{ url: string }>(path, { method: "POST", body, billing: true });
    if (sandboxed) {
      show("customer-status", "Your payment link is ready in the dashboard.");
    } else {
      const url = new URL(result.url);
      if (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        window.location.assign(url.href);
      }
    }
  });
  const load = () => Effect.gen(function* () {
    const current = yield* api<{ subscription: HostingSubscription; plan: HostingPlan }>("subscription").pipe(
      Effect.catch(error => error.status === 404 ? Effect.succeed(undefined) : Effect.fail(error)),
    );
    element("current").hidden = !current;
    element("offers").hidden = Boolean(current);
    element("billed").hidden = !current || current.subscription.state === "pending";
    if (!current) {
      const { plans } = yield* api<PlansView>("plans");
      element("offers-list").replaceChildren(...plans.map(plan => {
        const card = document.createElement("article");
        card.className = "zv-card zv-stack";
        card.append(text("h3", plan.title), text("p", priceLabel(plan)),
          text("p", `${plan.limits.projects} ${plan.limits.projects === 1 ? "Project" : "Projects"}`));
        if (plan.description) card.append(text("p", plan.description));
        card.append(button(`Subscribe to ${plan.title}`, control => action("customer-status", control, billing("checkout", { planId: plan.id }))));
        return card;
      }));
      show("customer-status", plans.length ? "" : "No hosting plans are available.");
      return;
    }

    const { subscription, plan } = current;
    show("subscription", `${plan.title} · ${stateLabel[subscription.state]}`);
    const grace = element("grace");
    grace.hidden = subscription.state !== "past_due" || !subscription.graceEndsAt;
    if (subscription.graceEndsAt) grace.textContent = `Grace ends ${dateLabel(subscription.graceEndsAt)}.`;
    const controls = element("billing-actions");
    controls.replaceChildren();
    if (subscription.state === "pending") controls.append(button("Continue checkout",
      control => action("customer-status", control, billing("checkout", { planId: plan.id }))));
    if (subscription.ecommerceSubscriptionId) controls.append(button("Manage billing",
      control => action("customer-status", control, billing("portal"))));
    show("customer-status", "");
    if (subscription.state === "pending") return;

    const { limit, reserved, projects } = yield* api<{ limit: number; reserved: number; projects: { id: string; name: string; status: string }[] }>("projects");
    show("quota", `${projects.length} of ${limit} Projects${reserved ? ` · ${reserved} provisioning` : ""}`);
    element("projects").replaceChildren(...projects.map(project => text("li", `${project.name} · ${project.status}`)));
    form.hidden = subscription.state !== "active" || projects.length + reserved >= limit;
    const recipe = field<HTMLSelectElement>(form, "recipeName");
    const recipes = plan.limits.recipes ?? ["@zelavis/app"];
    recipe.replaceChildren(...recipes.map(value => option(value, value === "@zelavis/app" ? "Zelavis App" : value)));
  });

  element<HTMLButtonElement>("refresh").addEventListener("click", event =>
    action("customer-status", event.currentTarget as HTMLButtonElement, load()));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const data = new FormData(form);
    action("customer-status", event.submitter as HTMLButtonElement, Effect.gen(function* () {
      const { projectId } = yield* api<{ projectId: string }>("projects", {
        method: "POST", body: { name: data.get("name"), recipeName: data.get("recipeName") },
      });
      form.hidden = true;
      show("customer-status", `Project ${projectId} created. Sign in again to use your new access.`);
    }));
  });
  Effect.runFork(load().pipe(Effect.catch(report("customer-status"))));
}

switch (document.querySelector<HTMLElement>("[data-hosting-page]")?.dataset.hostingPage) {
  case "plans": operatorPlans(); break;
  case "subscriptions": operatorSubscriptions(); break;
  case "customer": customerPage(); break;
}
