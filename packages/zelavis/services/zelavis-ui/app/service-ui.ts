// Only component families present in this document are imported. The Platform serves the build's exact module map.
import { Data, Effect, Fiber, Queue } from "effect";
import { defineBrand } from "fuzor/ui/core";

class ServiceUiLoadError extends Data.TaggedError("ServiceUiLoadError")<{ component: string; cause: unknown }> {}
const loadComponent = <A>(component: string, load: () => Promise<A>, register: (module: A) => void) =>
  Effect.tryPromise({ try: load, catch: cause => new ServiceUiLoadError({ component, cause }) }).pipe(
    Effect.flatMap(module => Effect.try({ try: () => register(module), catch: cause => new ServiceUiLoadError({ component, cause }) })),
  );

const components: Record<string, () => Effect.Effect<void, ServiceUiLoadError>> = {
  "accordion": () => loadComponent("accordion", () => import("fuzor/ui/components/accordion"), module => module.registerAccordion()),
  "avatar": () => loadComponent("avatar", () => import("fuzor/ui/components/avatar"), module => module.registerAvatar()),
  "checkbox": () => loadComponent("checkbox", () => import("fuzor/ui/components/checkbox"), module => module.registerCheckbox()),
  "collapsible": () => loadComponent("collapsible", () => import("fuzor/ui/components/collapsible"), module => module.registerCollapsible()),
  "combobox": () => loadComponent("combobox", () => import("fuzor/ui/components/combobox"), module => module.registerCombobox()),
  "dialog": () => loadComponent("dialog", () => import("fuzor/ui/components/dialog"), module => module.registerDialog()),
  "drawer": () => loadComponent("drawer", () => import("fuzor/ui/components/drawer"), module => module.registerDrawer()),
  "editable": () => loadComponent("editable", () => import("fuzor/ui/components/editable"), module => module.registerEditable()),
  "hover-card": () => loadComponent("hover-card", () => import("fuzor/ui/components/hover-card"), module => module.registerHoverCard()),
  "listbox": () => loadComponent("listbox", () => import("fuzor/ui/components/listbox"), module => module.registerListbox()),
  "menu": () => loadComponent("menu", () => import("fuzor/ui/components/menu"), module => module.registerMenu()),
  "number-input": () => loadComponent("number-input", () => import("fuzor/ui/components/number-input"), module => module.registerNumberInput()),
  "pagination": () => loadComponent("pagination", () => import("fuzor/ui/components/pagination"), module => module.registerPagination()),
  "password-input": () => loadComponent("password-input", () => import("fuzor/ui/components/password-input"), module => module.registerPasswordInput()),
  "pin-input": () => loadComponent("pin-input", () => import("fuzor/ui/components/pin-input"), module => module.registerPinInput()),
  "popover": () => loadComponent("popover", () => import("fuzor/ui/components/popover"), module => module.registerPopover()),
  "progress": () => loadComponent("progress", () => import("fuzor/ui/components/progress"), module => module.registerProgress()),
  "radio-group": () => loadComponent("radio-group", () => import("fuzor/ui/components/radio-group"), module => module.registerRadioGroup()),
  "rating-group": () => loadComponent("rating-group", () => import("fuzor/ui/components/rating-group"), module => module.registerRatingGroup()),
  "scroll-area": () => loadComponent("scroll-area", () => import("fuzor/ui/components/scroll-area"), module => module.registerScrollArea()),
  "select": () => loadComponent("select", () => import("fuzor/ui/components/select"), module => module.registerSelect()),
  "separator": () => loadComponent("separator", () => import("fuzor/ui/components/separator"), module => module.registerSeparator()),
  "slider": () => loadComponent("slider", () => import("fuzor/ui/components/slider"), module => module.registerSlider()),
  "steps": () => loadComponent("steps", () => import("fuzor/ui/components/steps"), module => module.registerSteps()),
  "switch": () => loadComponent("switch", () => import("fuzor/ui/components/switch"), module => module.registerSwitch()),
  "tabs": () => loadComponent("tabs", () => import("fuzor/ui/components/tabs"), module => module.registerTabs()),
  "tags-input": () => loadComponent("tags-input", () => import("fuzor/ui/components/tags-input"), module => module.registerTagsInput()),
  "toast": () => loadComponent("toast", () => import("fuzor/ui/components/toast"), module => module.registerToast()),
  "toggle": () => loadComponent("toggle", () => import("fuzor/ui/components/toggle"), module => module.registerToggle()),
  "toggle-group": () => loadComponent("toggle-group", () => import("fuzor/ui/components/toggle-group"), module => module.registerToggleGroup()),
  "tooltip": () => loadComponent("tooltip", () => import("fuzor/ui/components/tooltip"), module => module.registerTooltip()),
  "tree-view": () => loadComponent("tree-view", () => import("fuzor/ui/components/tree-view"), module => module.registerTreeView()),
};
// Longest first: toggle-group parts belong to toggle-group, not toggle.
const families = Object.keys(components).sort((left, right) => right.length - left.length);
const attempted = new Set<string>(); // At most the fixed component-family count; failed imports retry on reload.
defineBrand("zv");

function familyOf(element: Element): string | undefined {
  if (customElements.get(element.localName)) return;
  const name = element.localName.replace(/^(?:zv|fuzor)-/, "");
  if (name === element.localName) return;
  return families.find(family => name === family || name.startsWith(family + "-"));
}

const scan = Effect.fn("serviceUi.scan")(function*() {
  const found = new Set<string>();
  const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
  let element: Node | null, count = 0;
  while ((element = walker.nextNode())) {
    const family = familyOf(element as Element);
    if (family && !attempted.has(family)) found.add(family);
    // O(1) traversal memory; yield every bounded batch so a large page cannot monopolize a turn.
    if (++count % 512 === 0) yield* Effect.yieldNow;
  }
  yield* Effect.forEach(found, family => {
    attempted.add(family);
    return components[family]!().pipe(
      Effect.timeout("15 seconds"),
      Effect.catch(error => Effect.sync(() => {
        console.error(`Could not load service-page component ${family}. Reload to retry.`, error);
        document.dispatchEvent(new CustomEvent("zelavis-service-ui-error", { detail: { component: family } }));
      })),
      Effect.onInterrupt(() => Effect.sync(() => { attempted.delete(family); })),
    );
  }, { concurrency: 4, discard: true });
});

const watch = Effect.scoped(Effect.gen(function*() {
  // One coalesced notification, never a growing queue of DOM nodes or mutation records.
  const changes = yield* Queue.sliding<void>(1);
  const notify = () => { Queue.offerUnsafe(changes, undefined); };
  yield* Effect.acquireRelease(Effect.sync(() => {
    const observer = new MutationObserver(notify);
    observer.observe(document, { childList: true, subtree: true });
    notify();
    return observer;
  }), observer => Effect.sync(() => observer.disconnect()));
  yield* Effect.forever(Effect.gen(function*() { yield* Queue.take(changes); yield* scan(); }));
}));

let lifetime: Fiber.Fiber<void> | undefined;
const start = () => { lifetime ??= Effect.runFork(watch); };
window.addEventListener("pagehide", () => { if (lifetime) Effect.runFork(Fiber.interrupt(lifetime)); lifetime = undefined; });
window.addEventListener("pageshow", start);
start();
