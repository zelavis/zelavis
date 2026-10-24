import { Effect } from "effect";
import { array, label, object, request } from "./api.ts";
import { button, link, node } from "./dom.ts";
import { card, page } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";
import { dropdown } from "./dropdown.ts";

/** The Assistant: a conversation scoped to the Platform or to one Project, read from the Platform's Assistant endpoints. */
export const assistantScreen = Effect.fn("ui.assistantScreen")(function*(context: ScreenContext) {
  const api = context.config.api.basePath;
  const projectId = context.url.searchParams.get("project") ?? "";
  const requested = context.url.searchParams.get("thread") ?? "";
  const projects = array(object(yield* request(`${api}/runtime/projects`)).projects).map(object);
  const listing = object(yield* request(`${api}/runtime/assistant/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""}`));
  const threads = array(listing.threads).map(object);
  const selected = requested || label(threads[0]?.id, "");
  const thread = selected
    ? yield* request(`${api}/runtime/assistant/threads/${encodeURIComponent(selected)}`).pipe(Effect.map(result => ({ ...object(object(result).thread), approvals: array(object(result).approvals) } as Record<string, unknown>)), Effect.catch(() => Effect.succeed(undefined)))
    : undefined;

  const scope = dropdown({ label: "Assistant scope", value: projectId ?? "" }, [{ value: "", label: "Platform" }, ...projects.map(project => ({ value: label(project.id, ""), label: label(project.name) }))]);
  scope.addEventListener("change", () => context.navigate(scope.value ? `/assistant?${new URLSearchParams({ project: scope.value })}` : "/assistant"));
  const search = (id?: string) => { const query = new URLSearchParams(); if (id) query.set("thread", id); if (projectId) query.set("project", projectId); const text = query.toString(); return text ? `/assistant?${text}` : "/assistant"; };
  const history = node("div", { class: "actions" },
    link("New conversation", search(), { class: thread ? "" : "primary" }),
    ...threads.slice(0, 8).map(entry => link(label(entry.title, "Conversation"), search(label(entry.id, "")), { class: label(entry.id, "") === (thread ? label(thread.id, "") : "") ? "primary" : "" })));
  const island = document.createElement("fuzor-island");
  island.setAttribute("src", "assistant-chat");
  island.setAttribute("props", JSON.stringify({ api, projectId, threadId: thread ? label(thread.id, "") : "", thread }));
  return page(node("div", { class: "toolbar" }, node("label", {}, node("span", {}, "Scope"), scope), button("Refresh", () => context.refresh())), history, card(undefined, island));
});
