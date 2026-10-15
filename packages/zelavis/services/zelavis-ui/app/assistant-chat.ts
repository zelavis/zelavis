import { Effect, Fiber } from "effect";
import { ApiError, array, label, object, request } from "./api.ts";
import { button, link, node } from "./dom.ts";
import { readServerSentEvents } from "./sse.ts";

/**
 * The Assistant conversation island: messages, the reply as it is written, what it looked up, and the changes it asks
 * to make, which only a person approves. The model and everything it writes are untrusted, so replies are drawn as
 * text (never as HTML), and a reply names nothing the page loads.
 */

/** Inline `code` and **bold** as DOM nodes; everything else is text. */
export function inline(text: string): Node[] {
  const parts: Node[] = [];
  for (const piece of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
    if (!piece) continue;
    if (piece.startsWith("`") && piece.endsWith("`") && piece.length > 2) parts.push(node("code", {}, piece.slice(1, -1)));
    else if (piece.startsWith("**") && piece.endsWith("**") && piece.length > 4) parts.push(node("strong", {}, piece.slice(2, -2)));
    else parts.push(document.createTextNode(piece));
  }
  return parts;
}

/** Paragraphs, bullet lists and fenced code, drawn without ever parsing HTML. */
export function renderText(text: string): HTMLElement {
  const root = node("div", { class: "assistant-text" });
  let list: HTMLElement | undefined;
  let fence: string[] | undefined;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      if (fence) { root.append(node("pre", {}, fence.join("\n"))); fence = undefined; } else { fence = []; list = undefined; }
      continue;
    }
    if (fence) { fence.push(line); continue; }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) { list ??= root.appendChild(node("ul")); list.append(node("li", {}, ...inline(bullet[1]))); continue; }
    list = undefined;
    if (line.trim()) root.append(node("p", {}, ...inline(line)));
  }
  if (fence) root.append(node("pre", {}, fence.join("\n")));
  return root;
}

interface Approval { id: string; threadId: string; label: string; target: { kind: string; id: string }; irreversible: boolean; status: string; outcome?: string }

export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const api = String(props.api);
  const projectId = typeof props.projectId === "string" && props.projectId ? props.projectId : undefined;
  let threadId = typeof props.threadId === "string" && props.threadId ? props.threadId : undefined;
  const initial = object(props.thread);
  const approvals = new Map<string, Approval>(array(initial.approvals).map(object).map(entry => [label(entry.id, ""), { id: label(entry.id, ""), threadId: label(entry.threadId, ""), label: label(entry.label), target: { kind: label(object(entry.target).kind), id: label(object(entry.target).id, "") }, irreversible: entry.irreversible === true, status: label(entry.status), ...(typeof entry.outcome === "string" ? { outcome: entry.outcome } : {}) }]));
  const messages = array(initial.messages).map(object).map(entry => ({ role: label(entry.role), content: label(entry.content, ""), actions: array(entry.actions).map(object), activity: array(entry.activity).map(object), approvalIds: array(entry.approvalIds).map(String), provider: typeof entry.provider === "string" ? entry.provider : undefined }));
  const abort = new AbortController();
  const fibers = new Set<Fiber.Fiber<unknown, never>>();
  let streaming = false;
  let draft: typeof messages[number] | undefined;

  const list = node("div", { role: "log", "aria-label": "Conversation", class: "assistant-log" });
  const errors = node("div", { role: "alert" });
  const input = node("textarea", { name: "content", rows: "3", placeholder: "Send a message...", "aria-label": "Message", maxlength: "65536" });
  const send = node("button", { type: "submit", class: "primary" }, "Send");
  const form = node("form", { class: "assistant-compose" }, input, send);

  const decide = (approval: Approval, decision: "approve" | "deny", confirm?: string) => {
    fork(request(`${api}/runtime/assistant/threads/${encodeURIComponent(approval.threadId)}/approvals/${encodeURIComponent(approval.id)}`, "POST", { decision, ...(confirm ? { confirm } : {}) }).pipe(
      Effect.tap(result => Effect.sync(() => { const next = object(object(result).approval); approvals.set(approval.id, { ...approval, status: label(next.status, approval.status), ...(typeof next.outcome === "string" ? { outcome: next.outcome } : {}) }); })),
      // Whatever happened, the thread now holds the outcome (or the truth), so it is read again.
      Effect.ensuring(Effect.sync(() => { if (threadId) reloadThread(); }))));
  };
  const reloadThread = () => fork(request(`${api}/runtime/assistant/threads/${encodeURIComponent(threadId!)}`).pipe(Effect.tap(result => Effect.sync(() => {
    const thread = object(object(result).thread ?? result);
    const approvalList = array(object(result).approvals ?? thread.approvals);
    messages.splice(0, messages.length, ...array(thread.messages).map(object).map(entry => ({ role: label(entry.role), content: label(entry.content, ""), actions: array(entry.actions).map(object), activity: array(entry.activity).map(object), approvalIds: array(entry.approvalIds).map(String), provider: typeof entry.provider === "string" ? entry.provider : undefined })));
    for (const entry of approvalList.map(object)) approvals.set(label(entry.id, ""), { id: label(entry.id, ""), threadId: label(entry.threadId, ""), label: label(entry.label), target: { kind: label(object(entry.target).kind), id: label(object(entry.target).id, "") }, irreversible: entry.irreversible === true, status: label(entry.status), ...(typeof entry.outcome === "string" ? { outcome: entry.outcome } : {}) });
    render();
  }))));

  function approvalCard(approval: Approval) {
    const pending = approval.status === "pending";
    const confirm = node("input", { autocomplete: "off", spellcheck: "false", "aria-label": `Type ${approval.target.id} to confirm` });
    const approve = button("Approve", () => decide(approval, "approve", approval.irreversible ? confirm.value : undefined), { class: approval.irreversible ? "danger" : "primary", ...(approval.irreversible ? { disabled: "" } : {}) });
    confirm.addEventListener("input", () => { if (confirm.value === approval.target.id) approve.removeAttribute("disabled"); else approve.setAttribute("disabled", ""); });
    const resolved: Record<string, string> = { executed: "Approved", failed: "Approved, but it failed", denied: "Denied", expired: "Expired" };
    return node("section", { class: `notice${approval.irreversible && pending ? " error" : ""}`, "aria-label": "Approval needed" },
      node("strong", {}, approval.label), node("p", { class: "muted" }, `${approval.target.kind} · ${approval.target.id}`),
      ...(pending && approval.irreversible ? [node("p", { class: "danger", role: "alert" }, "This cannot be undone."), node("label", {}, node("span", {}, `Type ${approval.target.id} to confirm`), confirm)] : []),
      ...(pending ? [node("div", { class: "actions" }, button("Deny", () => decide(approval, "deny")), approve)] : [node("p", { class: "muted" }, approval.status === "running" ? "Running…" : `${resolved[approval.status] ?? approval.status}${approval.outcome ? `. ${approval.outcome}` : ""}`)]));
  }

  function messageNode(message: typeof messages[number], live = false) {
    const body = node("article", { class: `assistant-message ${message.role}` }, node("strong", {}, message.role === "user" ? "You" : "Assistant"));
    if (message.role === "assistant" && message.activity.length) body.append(node("ul", { "aria-label": "What the Assistant checked", class: "assistant-activity" }, ...message.activity.map(entry => node("li", { class: entry.status === "refused" ? "danger" : "" }, entry.status === "refused" ? `Not allowed: ${label(entry.label)}` : entry.status === "awaiting" ? `Waiting for your approval: ${label(entry.label)}` : `${entry.status === "running" ? "… " : "✓ "}${label(entry.label)}`))));
    body.append(message.role === "user" ? node("p", {}, message.content) : renderText(message.content || (live ? "…" : "")));
    if (message.provider) body.append(node("small", { class: "muted" }, message.provider === "local-router" ? "Built-in helper" : message.provider));
    for (const id of message.approvalIds) { const approval = approvals.get(id); if (approval) body.append(approvalCard(approval)); }
    if (message.actions.length) body.append(node("div", { class: "actions" }, ...message.actions.map(action => link(label(action.label), label(action.to, "/")))));
    return body;
  }

  function render() {
    list.replaceChildren(...(messages.length || draft ? [...messages.map(message => messageNode(message)), ...(draft ? [messageNode(draft, true)] : [])] : [node("p", { class: "muted assistant-empty" }, "How can I help you today?")]));
    send.toggleAttribute("disabled", streaming);
    list.scrollTop = list.scrollHeight;
  }

  function fork(work: Effect.Effect<unknown, ApiError>) {
    errors.replaceChildren();
    const fiber = Effect.runFork(work.pipe(Effect.catch(error => Effect.sync(() => { errors.replaceChildren(node("p", { class: "danger" }, error.message)); })), Effect.ensuring(Effect.sync(render))));
    fibers.add(fiber); fiber.addObserver(() => fibers.delete(fiber));
  }

  const stream = (content: string) => Effect.gen(function*() {
    if (!threadId) {
      const created = object(object(yield* request(`${api}/runtime/assistant/threads`, "POST", { ...(projectId ? { projectId } : {}) })).thread);
      threadId = label(created.id, "");
      const url = new URL(location.href); url.searchParams.set("thread", threadId); if (projectId) url.searchParams.set("project", projectId);
      history.replaceState(history.state, "", url);
    }
    messages.push({ role: "user", content, actions: [], activity: [], approvalIds: [], provider: undefined });
    draft = { role: "assistant", content: "", actions: [], activity: [], approvalIds: [], provider: undefined };
    streaming = true; render();
    const path = `${api}/runtime/assistant/threads/${encodeURIComponent(threadId)}/messages/stream`;
    const response = yield* Effect.tryPromise({ try: () => fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ content }), signal: abort.signal }), catch: () => new ApiError({ message: `Request failed for ${path}` }) });
    if (!response.ok || !response.body) {
      const refusal = yield* Effect.tryPromise({ try: () => response.json() as Promise<{ error?: unknown }>, catch: () => new ApiError({ message: `Request failed: ${response.status}` }) }).pipe(Effect.catch(() => Effect.succeed({} as { error?: unknown })));
      return yield* Effect.fail(new ApiError({ message: typeof refusal.error === "string" ? refusal.error : `Request failed: ${response.status}`, status: response.status }));
    }
    const body = response.body;
    yield* Effect.tryPromise({
      try: async () => {
        for await (const frame of readServerSentEvents(body)) {
          const data = object(frame.data);
          if (frame.event === "text") draft!.content += label(data.delta, "");
          else if (frame.event === "tool") { const others = draft!.activity.filter(entry => entry.id !== data.id); draft!.activity = [...others, { id: data.id, label: data.label, status: data.status }]; }
          else if (frame.event === "approval") { draft!.approvalIds.push(label(data.id, "")); approvals.set(label(data.id, ""), { id: label(data.id, ""), threadId: threadId!, label: label(data.label), target: { kind: label(object(data.target).kind), id: label(object(data.target).id, "") }, irreversible: data.irreversible === true, status: "pending" }); }
          else if (frame.event === "error") throw new Error(label(data.message, "The Assistant failed."));
          else if (frame.event === "done") {
            // The saved message is authoritative over what was streamed.
            const saved = object(data.assistantMessage);
            draft = { role: "assistant", content: label(saved.content, draft!.content), actions: array(saved.actions).map(object), activity: array(saved.activity).map(object), approvalIds: array(saved.approvalIds).map(String), provider: typeof saved.provider === "string" ? saved.provider : undefined };
          }
          render();
        }
      },
      catch: cause => new ApiError({ message: cause instanceof Error ? cause.message : String(cause) })
    });
    messages.push(draft!);
  }).pipe(Effect.ensuring(Effect.sync(() => { draft = undefined; streaming = false; })));

  form.addEventListener("submit", event => {
    event.preventDefault();
    const content = input.value.trim();
    if (!content || streaming) return;
    input.value = "";
    fork(stream(content));
  });
  input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });

  host.classList.add("assistant");
  host.replaceChildren(list, errors, form);
  render();
  return () => { abort.abort(); for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber)); fibers.clear(); host.replaceChildren(); };
}
