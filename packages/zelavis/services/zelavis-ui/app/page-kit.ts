import { node } from "./dom.ts";

/**
 * Presentation pieces shared by the natively rebuilt pages: a card, a labelled row with an optional
 * status, a statistic and a notice. They are plain DOM builders with no state; a page decides what to show.
 */

const GOOD = new Set(["ready", "running", "embedded", "endpoint", "active", "available", "verified", "healthy", "ok"]);
const WARN = new Set(["planned", "fallback", "checking", "provisioning", "starting", "stopping", "degraded", "draining", "preparing", "moving", "recovering", "draft"]);
const BAD = new Set(["failed", "unavailable", "error"]);

export function badge(state: string) {
  const tone = GOOD.has(state) ? "good" : WARN.has(state) ? "warn" : BAD.has(state) ? "bad" : "plain";
  return node("span", { class: `k-badge ${tone}` }, state);
}

export function card(title: string | undefined, ...body: (Node | string | undefined)[]) {
  return node("section", { class: "k-card" }, ...(title ? [node("h2", {}, title)] : []), ...body);
}

/** A card whose rows run to its edges, for lists of dataRow. */
export function rowsCard(title: string, ...rows: HTMLElement[]) {
  return node("section", { class: "k-card flush" }, ...(title ? [node("h2", {}, title)] : []), ...rows);
}

export function dataRow(label: string, detail: string, meta?: Node | string) {
  return node("div", { class: "k-row" }, node("div", {}, node("p", { class: "k-row-label" }, label), node("p", { class: "k-row-detail" }, detail)), ...(meta === undefined ? [] : [node("div", { class: "k-row-meta" }, meta)]));
}

export function statCard(label: string, value: string, detail: string) {
  return node("div", { class: "k-stat" }, node("span", {}, label), node("strong", {}, value), node("p", {}, detail));
}

export function resourceNotice(title: string, description: string) {
  return node("div", { class: "k-notice" }, node("p", { class: "k-row-label" }, title), node("p", { class: "k-row-detail" }, description));
}

/** Children laid out in equal columns that stack on a narrow screen. */
export function columns(count: 2 | 3, ...children: Node[]) {
  return node("div", { class: `k-grid cols-${count}` }, ...children);
}

export function page(...children: (Node | undefined)[]) {
  return node("section", { class: "k-page" }, ...children.filter((child): child is Node => child !== undefined));
}

/** A key/value list inside a card. */
export function facts(entries: readonly (readonly [string, string])[]) {
  const list = node("dl", { class: "k-facts" });
  for (const [name, value] of entries) list.append(node("div", {}, node("dt", {}, name), node("dd", {}, value)));
  return list;
}
