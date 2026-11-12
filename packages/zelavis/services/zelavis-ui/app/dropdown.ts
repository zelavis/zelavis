import { registerSelect } from "fuzor/ui/components/select";
import { ensureBrand } from "./brand.ts";

export interface DropdownOption { readonly value: string; readonly label: string; readonly disabled?: boolean }
export interface DropdownAttributes {
  readonly name?: string;
  /** What assistive technology calls it, and the text a form label would give a native select. */
  readonly label: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly required?: boolean;
  /** Several choices at once; `value` is then the first and `values` all of them. */
  readonly multiple?: boolean;
  readonly values?: readonly string[];
}
/** A `zv-select`: its `value` and `change` event behave as a native select's do, so a form and a listener need no change. */
export type DropdownElement = HTMLElement & { value: string; readonly values: string[]; disabled: boolean; setValue(value: string | string[]): void };

const chevron = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;

/** A value the page set itself: its `ui:value-change` is not a user's choice, so it raises no `change`. */
const programmatic = new WeakMap<HTMLElement, string>();

function items(doc: Document, options: readonly DropdownOption[]): HTMLElement[] {
  return options.map(option => {
    const item = doc.createElement("zv-select-item");
    item.setAttribute("value", option.value);
    if (option.disabled) item.setAttribute("disabled", "");
    item.textContent = option.label;
    return item;
  });
}

/**
 * A dropdown built on `fuzor/ui`'s select (Zag's listbox: typeahead, arrow keys, Escape, focus return), in place of a native
 * `<select>` whose open list the page cannot style. With a `name` it still submits in a form, through the hidden select the
 * component keeps. A user's choice dispatches `change` on the element, as a native select does; `setOptions` replaces the list.
 */
export function dropdown(attributes: DropdownAttributes, options: readonly DropdownOption[], doc: Document = document): DropdownElement {
  ensureBrand();
  registerSelect();
  const root = doc.createElement("zv-select") as DropdownElement;
  root.setAttribute("data-dropdown", attributes.label);
  if (attributes.name) root.setAttribute("name", attributes.name);
  if (attributes.disabled) root.setAttribute("disabled", "");
  if (attributes.required) root.setAttribute("required", "");
  if (attributes.multiple) root.setAttribute("multiple", "");
  const initial = attributes.multiple
    ? (attributes.values ?? []).join(",")
    : attributes.value ?? (attributes.placeholder === undefined ? options.find(option => !option.disabled)?.value : undefined);
  if (initial) root.setAttribute("value", initial);
  Object.defineProperty(root, "disabled", { get: () => root.hasAttribute("disabled"), set: (disabled: boolean) => { root.toggleAttribute("disabled", disabled); }, configurable: true });
  const trigger = doc.createElement("zv-select-trigger");
  trigger.setAttribute("aria-label", attributes.label);
  const text = doc.createElement("zv-select-value");
  text.setAttribute("placeholder", attributes.placeholder ?? "");
  const indicator = doc.createElement("zv-select-indicator");
  indicator.innerHTML = chevron;
  trigger.append(text, indicator);
  const content = doc.createElement("zv-select-content");
  content.append(...items(doc, options));
  root.append(trigger, content);
  let value = initial ?? "";
  root.addEventListener("ui:value-change", event => {
    const next = ((event as CustomEvent<{ values?: string[]; value: string }>).detail?.values ?? []).join(",");
    if (next === value) return;
    value = next;
    if (programmatic.get(root) === next) { programmatic.delete(root); return; }
    // A native select raises both: `input` for code that follows typing, `change` for code that follows choosing.
    root.dispatchEvent(new Event("input", { bubbles: true }));
    root.dispatchEvent(new Event("change", { bubbles: true }));
  });
  // The list is at least as wide as the control that opened it.
  new MutationObserver(() => { if (root.hasAttribute("open")) content.style.minWidth = `${trigger.getBoundingClientRect().width}px`; }).observe(root, { attributes: true, attributeFilter: ["open"] });
  return root;
}

/** Replaces a dropdown's choices, keeping its value when it is still offered (or taking `value`). */
export function setDropdownOptions(root: DropdownElement, options: readonly DropdownOption[], value?: string): void {
  const content = root.querySelector("zv-select-content")!;
  content.replaceChildren(...items(root.ownerDocument, options));
  const next = value ?? (options.some(option => option.value === root.value) ? root.value : options.find(option => !option.disabled)?.value ?? "");
  queueMicrotask(() => { if (root.value !== next) { programmatic.set(root, next); root.setValue(next); } });
}
