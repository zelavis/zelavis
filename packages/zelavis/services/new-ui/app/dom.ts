export function node<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string | undefined)[]): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) result.setAttribute(name, value);
  for (const child of children) if (child !== undefined) result.append(child);
  return result;
}
export function link(text: string, path: string, attrs: Record<string, string> = {}) { return node("a", { href: `/zelavis${path === "/" ? "/" : path}`, ...attrs }, text); }
export function button(text: string, action: () => void, attrs: Record<string, string> = {}) {
  const result = node("button", { type: "button", ...attrs }, text); result.addEventListener("click", action); return result;
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
