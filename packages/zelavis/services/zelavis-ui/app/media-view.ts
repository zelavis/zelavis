import { Effect, Fiber } from "effect";
import { ApiError, array, label, object, request, storagePath, uploadFile } from "./api.ts";
import { button, node } from "./dom.ts";
import { formatBytes, uploadHeaders } from "./storage-pages.ts";

/**
 * The media gallery island: upload, filter, select, copy, delete and drag to reorder the Project's image assets.
 * It owns its state and re-renders from it; everything started here belongs to the returned cleanup.
 * Order is persisted through the Platform's dashboard settings (`preferences.media.orderedPaths`).
 */

interface Asset { path: string; contentType?: string; size?: number; metadata: Record<string, string>; }

const isImage = (asset: Asset) => asset.contentType?.toLowerCase().startsWith("image/") === true || /\.(avif|gif|jpe?g|png|svg|webp)$/i.test(asset.path);
const nameOf = (asset: Asset) => asset.metadata.label || asset.path.split("/").filter(Boolean).at(-1) || asset.path;

/** Visible assets in the saved order; anything unranked follows by path. */
export function orderAssets<T extends { path: string }>(files: readonly T[], ordered: readonly string[]): T[] {
  const rank = new Map(ordered.map((path, index) => [path, index]));
  return [...files].sort((left, right) => (rank.get(left.path) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.path) ?? Number.MAX_SAFE_INTEGER) || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** The order after moving `dragged` before `target`. */
export function moveBefore(order: readonly string[], dragged: string, target: string): string[] {
  const next = order.filter(path => path !== dragged);
  const index = next.indexOf(target);
  if (index === -1) next.push(dragged); else next.splice(index, 0, dragged);
  return next;
}

export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const api = String(props.apiBase);
  const control = String(props.controlApi);
  const params = new URL(location.href).searchParams;
  const state = {
    files: [] as Asset[], ordered: array(props.orderedPaths).map(String), selected: new Set<string>(), inspected: params.get("path") ?? "",
    prefix: params.get("prefix") ?? "", type: params.get("type") ?? "", label: params.get("label") ?? "", purpose: params.get("purpose") ?? "",
    reference: undefined as Record<string, unknown> | undefined, message: "", error: "", busy: false, progress: undefined as number | undefined, storage: true
  };
  let dragged = "";
  const fibers = new Set<Fiber.Fiber<unknown, never>>();
  const fork = (work: Effect.Effect<unknown, ApiError>, done?: () => void) => {
    state.busy = true; state.error = ""; render();
    const fiber = Effect.runFork(work.pipe(
      Effect.tap(() => Effect.sync(() => done?.())),
      Effect.catch(error => Effect.sync(() => { state.error = error.message; })),
      Effect.ensuring(Effect.sync(() => { state.busy = false; state.progress = undefined; render(); }))));
    fibers.add(fiber);
    fiber.addObserver(() => fibers.delete(fiber));
  };
  const copy = (text: string, done: string) => fork(Effect.tryPromise({ try: () => navigator.clipboard.writeText(text), catch: () => new ApiError({ message: "Copying is not available here." }) }), () => { state.message = done; });
  const urlOf = (path: string) => `${api}/storage/files/${storagePath(path)}`;
  const syncUrl = () => {
    const url = new URL(location.href);
    for (const [key, value] of Object.entries({ prefix: state.prefix, type: state.type, label: state.label, purpose: state.purpose, path: state.inspected })) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); }
    history.replaceState(history.state, "", url);
  };

  const load = Effect.gen(function*() {
    const listing = object(yield* request(`${api}/storage/files${state.prefix ? `?prefix=${encodeURIComponent(state.prefix)}` : ""}`));
    state.files = array(listing.files).map(object).map(entry => ({ path: label(entry.path, ""), contentType: typeof entry.contentType === "string" ? entry.contentType : undefined, size: typeof entry.size === "number" ? entry.size : undefined, metadata: Object.fromEntries(Object.entries(object(entry.metadata)).filter(([, value]) => typeof value === "string")) as Record<string, string> }));
    state.reference = undefined;
    if (state.inspected) {
      const detail = yield* request(`${api}/storage/files/${storagePath(state.inspected)}?format=metadata`).pipe(Effect.catch(() => Effect.succeed(undefined)));
      state.reference = detail ? object(object(detail).reference) : undefined;
    }
  });
  const reload = () => fork(load);

  const visible = () => state.files.filter(file => {
    const contains = (value: string | undefined, needle: string) => !needle.trim() || (value ?? "").toLowerCase().includes(needle.trim().toLowerCase());
    return contains(file.contentType, state.type) && contains(file.metadata.label, state.label) && contains(file.metadata.purpose, state.purpose);
  });

  const persist = (order: string[]) => {
    const merged = [...order, ...array(props.orderedPaths).map(String).filter(path => !order.includes(path))];
    fork(request(`${control}/runtime/settings`, "PATCH", { preferences: { media: { orderedPaths: merged } } }));
  };

  function render() {
    const files = orderAssets(visible(), state.ordered);
    const selected = files.filter(file => state.selected.has(file.path));
    const inspected = state.files.find(file => file.path === state.inspected);
    const filterInput = (name: string, title: string, key: "prefix" | "type" | "label" | "purpose", placeholder: string) => {
      const input = node("input", { name, value: state[key], placeholder, "aria-label": title });
      input.addEventListener("change", () => { state[key] = input.value; syncUrl(); if (key === "prefix") reload(); else render(); });
      return node("label", {}, node("span", {}, title), input);
    };
    const picker = node("input", { type: "file", "aria-label": "File", ...(state.busy ? { disabled: "" } : {}) });
    const pathInput = node("input", { name: "path", placeholder: "media/hero.jpg", "aria-label": "Media path" });
    const labelInput = node("input", { name: "label", placeholder: "Hero image", "aria-label": "Label metadata" });
    const altInput = node("input", { name: "alt", placeholder: "Product hero shot", "aria-label": "Alt text metadata" });
    let chosen: File | undefined;
    picker.addEventListener("change", () => { chosen = picker.files?.[0]; if (chosen && !pathInput.value.trim()) pathInput.value = chosen.name; });
    const zone = node("div", { class: "drop-zone" }, node("strong", {}, "Drag a file here or choose one from disk"), node("p", { class: "muted" }, "This keeps the editor flow lightweight while still writing into the storage core. Reordering the gallery persists through Zelavis runtime settings."), picker);
    zone.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("dragging"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
    zone.addEventListener("drop", event => { event.preventDefault(); zone.classList.remove("dragging"); chosen = event.dataTransfer?.files?.[0]; if (chosen && !pathInput.value.trim()) pathInput.value = chosen.name; });
    const upload = node("form", { class: "form wide" }, filterInput("prefix", "Gallery filter", "prefix", "media/"), node("label", {}, node("span", {}, "Media path"), pathInput), zone, node("label", {}, node("span", {}, "Label metadata"), labelInput), node("label", {}, node("span", {}, "Alt text metadata"), altInput),
      node("div", { class: "actions" }, node("button", { type: "submit", class: "primary", ...(state.busy ? { disabled: "" } : {}) }, state.busy ? (state.progress !== undefined ? `Uploading ${state.progress}%` : "Working…") : "Add media")));
    upload.addEventListener("submit", event => {
      event.preventDefault();
      if (!chosen || state.busy) return;
      const file = chosen;
      const target = pathInput.value.trim() || file.name;
      fork(uploadFile(api, target, file, percent => { state.progress = percent; render(); }, uploadHeaders({ label: labelInput.value, alt: altInput.value, purpose: "media-gallery" })).pipe(Effect.flatMap(() => load)), () => { state.selected.add(target); state.inspected = target; state.message = `Added ${target} to the media gallery.`; syncUrl(); });
    });

    const cards = files.map(file => {
      const card = node("div", { class: `media-card${file.path === state.inspected ? " inspected" : ""}`, draggable: "true" });
      const open = node("button", { type: "button", class: "media-open" },
        isImage(file) ? node("img", { src: urlOf(file.path), alt: file.metadata.alt ?? nameOf(file), loading: "lazy" }) : node("div", { class: "media-file" }, "File"),
        node("strong", {}, nameOf(file)), node("span", { class: "muted" }, file.metadata.alt || file.path), node("span", { class: "muted" }, [file.contentType ?? "application/octet-stream", formatBytes(file.size)].join(" · ")));
      open.addEventListener("click", () => { state.inspected = file.path; syncUrl(); reload(); });
      const check = node("input", { type: "checkbox", ...(state.selected.has(file.path) ? { checked: "" } : {}) });
      check.addEventListener("change", () => { if (check.checked) state.selected.add(file.path); else state.selected.delete(file.path); render(); });
      card.append(open, node("label", { class: "media-select" }, check, "Select"), node("span", { class: "muted" }, "Drag to reorder"));
      card.addEventListener("dragstart", () => { dragged = file.path; });
      card.addEventListener("dragover", event => event.preventDefault());
      card.addEventListener("drop", event => { event.preventDefault(); if (dragged && dragged !== file.path) { state.ordered = moveBefore(files.map(entry => entry.path), dragged, file.path); persist(state.ordered); } dragged = ""; });
      return card;
    });

    const bulk = node("div", { class: "actions" },
      button("Select All", () => { state.selected = new Set(files.map(file => file.path)); render(); }, files.length ? {} : { disabled: "" }),
      button("Clear", () => { state.selected.clear(); render(); }, state.selected.size ? {} : { disabled: "" }),
      button("Copy URLs", () => copy(selected.map(file => new URL(urlOf(file.path), location.href).href).join("\n"), `Copied ${selected.length} media URLs.`), selected.length ? {} : { disabled: "" }),
      button("Copy References", () => fork(Effect.gen(function*() {
        const references = yield* Effect.forEach(selected, file => request(`${api}/storage/files/${storagePath(file.path)}?format=metadata`).pipe(Effect.map(detail => object(object(detail).reference))), { concurrency: 4 });
        yield* Effect.tryPromise({ try: () => navigator.clipboard.writeText(JSON.stringify(references, null, 2)), catch: () => new ApiError({ message: "Copying is not available here." }) });
      }), () => { state.message = `Copied ${selected.length} media references.`; }), selected.length ? {} : { disabled: "" }),
      button("Delete Selected", () => { if (window.confirm(`Delete ${selected.length} selected media item(s)?`)) fork(Effect.forEach(selected, file => request(`${api}/storage/files/${storagePath(file.path)}`, "DELETE"), { concurrency: 4 }).pipe(Effect.flatMap(() => load)), () => { if (selected.some(file => file.path === state.inspected)) state.inspected = ""; state.selected.clear(); state.message = `Deleted ${selected.length} selected media item(s).`; syncUrl(); }); }, { class: "danger", ...(selected.length && !state.busy ? {} : { disabled: "" }) }));

    const detail = inspected && state.reference
      ? node("div", { class: "k-stack" }, node("strong", {}, nameOf(inspected)), node("p", { class: "muted" }, inspected.path),
        node("p", {}, `Content type: ${inspected.contentType ?? "Unknown"}`), node("p", {}, `Size: ${formatBytes(inspected.size)}`), node("p", {}, `Alt text: ${inspected.metadata.alt ?? "Not set"}`), node("p", {}, `Purpose: ${inspected.metadata.purpose ?? "Not set"}`),
        node("div", { class: "actions" }, button("Copy URL", () => copy(new URL(urlOf(inspected.path), location.href).href, "Copied media URL.")), button("Copy Reference", () => copy(JSON.stringify(state.reference, null, 2), "Copied media reference JSON.")), node("a", { href: urlOf(inspected.path), target: "_blank", rel: "noreferrer" }, "Open File")),
        node("h3", {}, "Reference JSON"), node("pre", {}, JSON.stringify(state.reference, null, 2)))
      : node("div", { class: "k-notice" }, node("p", { class: "k-row-label" }, "Select media"), node("p", { class: "k-row-detail" }, "Choose an asset to preview its reusable URL and Zelavis file reference."));

    host.replaceChildren(
      node("div", { class: "k-grid cols-3" },
        node("div", { class: "k-stat" }, node("span", {}, "Visible assets"), node("strong", {}, String(state.files.length)), node("p", {}, "Files under the current gallery filters")),
        node("div", { class: "k-stat" }, node("span", {}, "Images"), node("strong", {}, String(files.filter(isImage).length)), node("p", {}, "Renderable image assets ready for previews")),
        node("div", { class: "k-stat" }, node("span", {}, "Selected"), node("strong", {}, String(state.selected.size)), node("p", {}, "Bulk actions stay available for the current selection"))),
      node("div", { class: "k-grid cols-2" },
        node("section", { class: "k-card" }, node("h2", {}, "Upload and browse"), upload,
          node("div", { class: "filters" }, filterInput("type", "Type", "type", "image/"), filterInput("label", "Label", "label", "hero"), filterInput("purpose", "Purpose", "purpose", "media-gallery")),
          ...(state.message ? [node("div", { class: "k-notice", role: "status" }, state.message)] : []), ...(state.error ? [node("div", { class: "notice error", role: "alert" }, state.error)] : []),
          bulk,
          files.length ? node("div", { class: "media-grid" }, ...cards) : node("div", { class: "k-notice" }, node("p", { class: "k-row-label" }, "No media yet"), node("p", { class: "k-row-detail" }, "Upload a file or clear the current filters to show more assets."))),
        node("section", { class: "k-card" }, node("h2", {}, "Asset details"), detail)));
  }

  render();
  fork(load);
  return () => { for (const fiber of fibers) Effect.runFork(Fiber.interrupt(fiber)); fibers.clear(); host.replaceChildren(); };
}
