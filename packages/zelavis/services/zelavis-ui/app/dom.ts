import { mounted } from "./mount.ts";
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | undefined)[]): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) result.setAttribute(name, value);
  for (const child of children) if (child !== undefined) result.append(child);
  return result;
}
export function link(text: string, path: string, attrs: Record<string, string> = {}) { return node("a", { href: mounted(path), ...attrs }, text); }
export function button(text: string, action: () => void, attrs: Record<string, string> = {}) {
  const result = node("button", { type: "button", ...attrs }, text); result.addEventListener("click", action); return result;
}
/**
 * The back row at the top of a sidebar slide: a full-width button with the slide's title centered and a chevron at the left edge
 * that nudges on hover. It sticks to the top of the slide, so it stays in reach however far the menu below it scrolls. The title
 * is a `.back-title` element, so a caller whose title changes (the mobile content slide) can update it.
 */
export function backRow(title: string, parent: string, action: () => void) {
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  chevron.setAttribute("viewBox", "0 0 24 24"); chevron.setAttribute("class", "back-chevron"); chevron.setAttribute("aria-hidden", "true");
  chevron.setAttribute("fill", "none"); chevron.setAttribute("stroke", "currentColor"); chevron.setAttribute("stroke-width", "2"); chevron.setAttribute("stroke-linecap", "round"); chevron.setAttribute("stroke-linejoin", "round");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m15 18-6-6 6-6"); chevron.append(path);
  const control = node("button", { type: "button", class: "back-row", title: `Back to ${parent}`, "aria-label": `Back to ${parent}` }, chevron, node("span", { class: "back-title" }, title));
  control.addEventListener("click", action);
  return node("div", { class: "panel-heading" }, control);
}
export function field(name: string, title: string, type = "text", value = "", required = true) {
  const input = node("input", { name, type, value, ...(required ? { required: "" } : {}), maxlength: "512", autocomplete: type === "password" ? "current-password" : "off" });
  return node("label", {}, node("span", {}, title), input);
}
export function message(text: string, error = false) { return node("div", { class: error ? "notice error" : "notice", role: error ? "alert" : "status" }, text); }
export function empty(title: string, description: string) { return node("div", { class: "empty" }, node("h2", {}, title), node("p", {}, description)); }
export function json(value: unknown) { return node("pre", { class: "json" }, JSON.stringify(value, null, 2)); }
export function table(records: unknown[], columns: string[]) {
  const result = node("table");
  result.append(node("thead", {}, node("tr", {}, ...columns.map(column => node("th", { scope: "col" }, column)))));
  const body = node("tbody");
  for (const record of records) {
    const values = record !== null && typeof record === "object" ? record as Record<string, unknown> : { value: record };
    body.append(node("tr", {}, ...columns.map(column => node("td", {}, typeof values[column] === "object" ? JSON.stringify(values[column]) : String(values[column] ?? "—")))));
  }
  result.append(body);
  return node("div", { class: "table-wrap" }, result);
}
