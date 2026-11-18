import { array, label, object, request } from "./api.ts";
import { button, node } from "./dom.ts";
import { canAccess } from "./navigation-menu.ts";
import { card, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/** The same persisted policy used by HTTP, the SDK and CLI; form units are GiB. */
export function cloudPolicyCard(context: ScreenContext, api: string, saved: Record<string, unknown>) {
  const policy = object(saved.policy);
  const classes = node("div", { class: "form", "data-machine-classes": "" });
  const rows: { element: HTMLElement; name: HTMLInputElement; cpu: HTMLInputElement; memory: HTMLInputElement; disk: HTMLInputElement }[] = [];
  const add = button("Add machine class", () => append({}));
  const append = (value: Record<string, unknown>) => {
    if (rows.length >= 16) return;
    const input = (title: string, value: string, numeric = false) => node("input", { "aria-label": title, required: "", value, ...(numeric ? { type: "number", min: "0.25", step: "0.25" } : { maxlength: "128" }) });
    const name = input("Class name", label(value.name, ""));
    const cpu = input("CPU cores", label(value.cpuCores, ""), true); cpu.min = "0.01"; cpu.step = "any";
    const gb = (value: unknown) => typeof value === "number" ? String(value / 1024 ** 3) : "";
    const memory = input("Memory (GiB)", gb(value.memoryBytes), true);
    const disk = input("Disk (GiB)", gb(value.diskBytes), true);
    const row = node("div", { class: "form", "data-machine-class": "" },
      node("div", { class: "filters" }, ...[["Name", name], ["CPU", cpu], ["Memory (GiB)", memory], ["Disk (GiB)", disk]].map(([title, control]) => node("label", {}, node("span", {}, title as string), control as HTMLInputElement))),
      button("Remove machine class", () => { rows.splice(rows.findIndex(entry => entry.element === row), 1); row.remove(); add.disabled = false; }));
    rows.push({ element: row, name, cpu, memory, disk }); classes.append(row); add.disabled = rows.length >= 16;
  };
  const existing = array(policy.machineClasses).map(object);
  for (const value of existing.length ? existing : [{}]) append(value);
  const location = node("input", { name: "location", "aria-label": "Policy location", required: "", maxlength: "128", value: label(policy.location, "") });
  const image = node("input", { name: "image", "aria-label": "Machine image", required: "", maxlength: "128", value: label(policy.image, "") });
  const maximum = node("input", { name: "maxNodes", "aria-label": "Maximum nodes", type: "number", required: "", min: "1", max: "100", step: "1", value: label(policy.maxNodes, "1") });
  const form = node("form", { class: "form", "data-cloud-policy": "" },
    node("div", { class: "filters" }, node("label", {}, node("span", {}, "Location"), location), node("label", {}, node("span", {}, "Image"), image), node("label", {}, node("span", {}, "Maximum nodes"), maximum)),
    classes, node("div", { class: "actions" }, add, node("button", { type: "submit", class: "primary" }, "Save machine policy")));
  form.addEventListener("submit", event => {
    event.preventDefault();
    context.run(request(`${api}/policy`, "PUT", {
      policy: { location: location.value.trim(), image: image.value.trim(), maxNodes: Number(maximum.value),
        ...(policy.allowedLocations === undefined ? {} : { allowedLocations: policy.allowedLocations }),
        machineClasses: rows.map(row => ({ name: row.name.value.trim(), cpuCores: Number(row.cpu.value), memoryBytes: Number(row.memory.value) * 1024 ** 3, diskBytes: Number(row.disk.value) * 1024 ** 3 })) },
      ...(typeof saved.updatedAt === "number" ? { expectedUpdatedAt: saved.updatedAt } : {}),
    }), () => { setFlash("Machine policy saved.", "cloud"); context.refresh(); });
  });
  if (!canAccess(context.config.access, { permissions: ["server.cloud.connect"] })) {
    for (const control of form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) control.disabled = true;
  }
  return card("Machine policy", node("p", {}, "Choose the location, image and approved machine sizes before connecting a provider. Your automation receives these values as hints. Sizes are in GiB."), form);
}
