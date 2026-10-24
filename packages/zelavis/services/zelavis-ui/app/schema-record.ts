import type { CollectionFieldEntry } from "zelavis/db/schema";
import { node, message } from "./dom.ts";
import { object } from "./api.ts";
import { dropdown, type DropdownElement } from "./dropdown.ts";

/** All values enter the same JSON inspector/journal; the server validates writes. */
export function schemaRecordFields(fields: readonly CollectionFieldEntry[], text: HTMLTextAreaElement, readonly: boolean) {
  const form = node("div", { class: "schema-record form" });
  const errors = node("div", { "aria-live": "polite" });
  const controls: { name: string; control: HTMLInputElement | HTMLTextAreaElement | DropdownElement; update(value: unknown): void }[] = [];
  const read = () => {
    const data: unknown = JSON.parse(text.value);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Record data must be a JSON object.");
    return object(data);
  };
  for (const entry of fields) {
    const field = entry.field, tag = field._tag;
    let control: HTMLInputElement | HTMLTextAreaElement | DropdownElement;
    let decode: () => unknown;
    let update: (value: unknown) => void;
    if (tag === "BooleanField") {
      const input = node("input", { type: "checkbox" }); control = input;
      decode = () => input.checked; update = value => { input.checked = value === true; };
    } else if (tag === "SelectField" || tag === "MultiSelectField") {
      const multiple = tag === "MultiSelectField";
      const select = dropdown({ label: field.label || entry.name, multiple, ...(multiple ? {} : { value: "" }) }, [...(multiple ? [] : [{ value: "", label: "Choose…" }]), ...field.options.map(value => ({ value, label: value }))]); control = select;
      decode = () => multiple ? [...select.values] : select.value || undefined;
      update = value => { const next = Array.isArray(value) ? value.map(String) : value === undefined ? [] : [String(value)]; if (next.join(",") !== select.values.join(",")) select.setValue(multiple ? next : next[0] ?? ""); };
    } else if (["NumberField", "IntegerField"].includes(tag)) {
      const input = node("input", { type: "number", step: tag === "IntegerField" ? "1" : "any" }); control = input;
      decode = () => { if (input.value === "") return undefined; const value = Number(input.value); if (!Number.isFinite(value) || tag === "IntegerField" && !Number.isSafeInteger(value)) throw new Error("Use a finite number or safe integer."); return value; };
      update = value => { input.value = value === undefined ? "" : String(value); };
    } else if (["JsonField", "ReferenceField", "RepeaterField", "FileField", "ImageField", "AudioField", "VideoField"].includes(tag)) {
      const input = node("textarea", { rows: "4", maxlength: "1048576" }); control = input;
      decode = () => input.value.trim() ? JSON.parse(input.value) as unknown : undefined;
      update = value => { input.value = value === undefined ? "" : JSON.stringify(value, null, 2); };
    } else {
      const input = tag === "LongTextField" || tag === "RichTextField" ? node("textarea", { rows: "4", maxlength: "1048576" }) : node("input", { type: tag === "UrlField" ? "url" : "text", maxlength: "1048576" }); control = input;
      decode = () => input.value === "" && !field.required ? undefined : input.value;
      update = value => { input.value = value === undefined ? "" : String(value); };
    }
    if (control.localName !== "zv-select") control.setAttribute("aria-label", field.label || entry.name);
    if (readonly) control.disabled = true;
    controls.push({ name: entry.name, control, update });
    control.addEventListener("input", () => {
      try {
        const data = read(), value = decode();
        if (value === undefined) delete data[entry.name]; else Object.defineProperty(data, entry.name, { value, enumerable: true, configurable: true, writable: true });
        text.value = JSON.stringify(data, null, 2);
        text.dispatchEvent(new Event("input", { bubbles: true }));
        errors.replaceChildren();
      } catch (cause) { errors.replaceChildren(message(`${entry.name}: ${String(cause)}. This field text is not yet in the recoverable JSON draft.`, true)); }
    });
    form.append(node("label", {}, node("span", {}, `${field.label || entry.name}${field.required ? " *" : ""}`), control, field._tag === "RichTextField" ? node("small", {}, "HTML source; content is never executed here.") : undefined));
  }
  form.append(errors);
  const sync = () => {
    try { const data = read(); for (const entry of controls) if (entry.control !== text.ownerDocument.activeElement) entry.update(Object.hasOwn(data, entry.name) ? data[entry.name] : undefined); }
    catch (cause) { errors.replaceChildren(message(`Complete the record JSON before editing schema fields: ${String(cause)}`, true)); }
  };
  text.addEventListener("change", sync);
  sync();
  return { element: form, sync, setDisabled(disabled: boolean) { for (const entry of controls) entry.control.disabled = readonly || disabled; } };
}
