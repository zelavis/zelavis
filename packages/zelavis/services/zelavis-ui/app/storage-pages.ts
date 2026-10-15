import { Effect } from "effect";
import { ApiError, array, label, object, request, storagePath, uploadFile, type Config } from "./api.ts";
import { button, link, node } from "./dom.ts";
import { badge, card, columns, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash, statCard } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

/** Project → Storage: upload, browse, inspect and delete files, and copy a file's ready-to-use reference. */

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "Unknown";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value;
  let unit = -1;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** The header names the storage service reads a file's metadata and cache policy from. The Gateway strips x-zelavis-*, so metadata travels as x-file-meta-*. */
export function uploadHeaders(input: { label?: string; alt?: string; purpose?: string; cacheControl?: string; contentDisposition?: string }) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries({ label: input.label, alt: input.alt, purpose: input.purpose })) if (value?.trim()) headers[`x-file-meta-${key}`] = value.trim();
  if (input.cacheControl?.trim()) headers["cache-control"] = input.cacheControl.trim();
  if (input.contentDisposition?.trim()) headers["content-disposition"] = input.contentDisposition.trim();
  return headers;
}

export const storageScreen = Effect.fn("ui.storageScreen")(function*(context: ScreenContext, scoped: Config) {
  const api = scoped.api.basePath;
  const enabled = array(scoped.services).some(service => object(service).name === "@zelavis/storage") || object(object(scoped.capabilities).storage).available === true;
  const databaseEnabled = object(object(scoped.capabilities).database).available === true;
  const prefix = context.url.searchParams.get("prefix") ?? "";
  const selected = context.url.searchParams.get("path") ?? "";
  const listing = enabled ? object(yield* request(`${api}/storage/files${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""}`).pipe(Effect.catch(() => Effect.succeed({})))) : {};
  const files = array(listing.files).map(object);
  const metadata = enabled && selected
    ? object(yield* Effect.try({ try: () => storagePath(selected), catch: cause => new ApiError({ message: String(cause) }) }).pipe(Effect.flatMap(encoded => request(`${api}/storage/files/${encoded}?format=metadata`)), Effect.catch(() => Effect.succeed({}))))
    : {};
  const file = object(metadata.file);
  const reference = object(metadata.reference);
  const total = files.reduce((sum, entry) => sum + (Number(entry.size) || 0), 0);

  const done = (text: string) => { setFlash(text); context.refresh(); };
  const prefixInput = node("input", { name: "prefix", value: prefix, placeholder: "uploads/", "aria-label": "Prefix filter" });
  const filter = node("form", { class: "filters", role: "search" }, node("label", {}, node("span", {}, "Prefix filter"), prefixInput), node("button", { type: "submit" }, "Open folder"));
  filter.addEventListener("submit", event => { event.preventDefault(); context.setSearch({ prefix: prefixInput.value.trim() || undefined, path: undefined }); });

  const pathInput = node("input", { name: "path", placeholder: "uploads/hello.txt", "aria-label": "Upload path" });
  const picker = node("input", { type: "file", name: "file", "aria-label": "File" });
  let chosen: File | undefined;
  const chosenText = node("p", { class: "muted" }, "Choose a file to upload into the mounted storage service.");
  const choose = (next: File | undefined) => {
    if (!next) return;
    chosen = next;
    if (!pathInput.value.trim()) pathInput.value = next.name;
    chosenText.textContent = `${next.name} · ${formatBytes(next.size)}`;
  };
  picker.addEventListener("change", () => choose(picker.files?.[0]));
  const zone = node("div", { class: "drop-zone" }, node("strong", {}, "Drag a file here or choose one from disk"), node("p", { class: "muted" }, "The upload path stays editable, so you can drop a file and still move it under a prefix like uploads/."), picker);
  zone.addEventListener("dragover", event => { event.preventDefault(); zone.classList.add("dragging"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));
  zone.addEventListener("drop", event => { event.preventDefault(); zone.classList.remove("dragging"); choose(event.dataTransfer?.files?.[0]); });
  const fields = ([["Label metadata", "label", "Hero image"], ["Alt text metadata", "alt", "Product hero shot on white background"], ["Purpose metadata", "purpose", "product-gallery"], ["Cache-Control", "cacheControl", "public, max-age=31536000, immutable"], ["Content-Disposition", "contentDisposition", 'inline; filename="hero.jpg"']] as const)
    .map(([title, name, placeholder]) => node("label", {}, node("span", {}, title), node("input", { name, placeholder, "aria-label": title })));
  const progress = node("progress", { max: "100", value: "0", hidden: "" });
  const upload = node("form", { class: "form wide" }, node("label", {}, node("span", {}, "Upload path"), pathInput), zone, ...fields, node("div", { class: "actions" }, node("button", { type: "submit", class: "primary" }, "Upload file"), chosenText), progress);
  upload.addEventListener("submit", event => {
    event.preventDefault();
    if (!chosen) return;
    const data = new FormData(upload);
    const text = (key: string) => String(data.get(key) ?? "");
    const target = pathInput.value.trim() || chosen.name;
    progress.hidden = false;
    context.run(uploadFile(api, target, chosen, percent => { progress.value = percent; }, uploadHeaders({ label: text("label"), alt: text("alt"), purpose: text("purpose"), cacheControl: text("cacheControl"), contentDisposition: text("contentDisposition") })), () => {
      setFlash(`Uploaded ${target}.`);
      context.setSearch({ path: target });
    });
  });

  const rows = files.map(entry => {
    const path = label(entry.path, "");
    return dataRow(path, [label(entry.contentType, "application/octet-stream"), formatBytes(Number(entry.size)), entry.updatedAt ? new Date(label(entry.updatedAt, "")).toLocaleString() : "timestamp unavailable"].join(" · "),
      node("span", { class: "actions" },
        button("Inspect", () => context.setSearch({ path })),
        button("Delete", () => { if (window.confirm(`Delete file ${path}?`)) context.run(Effect.try({ try: () => storagePath(path), catch: cause => new ApiError({ message: String(cause) }) }).pipe(Effect.flatMap(encoded => request(`${api}/storage/files/${encoded}`, "DELETE"))), () => { done(`Deleted ${path}.`); }); }, { class: "danger", "aria-label": `Delete ${path}` })));
  });

  const detail: Node[] = [];
  if (selected && file.path) {
    const copy = button("Copy JSON", () => { if (navigator.clipboard) context.run(Effect.tryPromise({ try: () => navigator.clipboard.writeText(JSON.stringify(reference, null, 2)), catch: () => new ApiError({ message: "The reference could not be copied." }) }), () => done("Copied file reference JSON.")); });
    const sample = databaseEnabled ? [button("Insert sample document", () => context.run(insertSample(scoped, reference), id => done(`Inserted sample document ${id} into storage_assets.`)))] : [];
    detail.push(
      resourceNotice(label(file.path), label(reference.href, "")),
      node("div", { class: "k-row-meta" }, node("span", {}, "Checksum"), badge(file.checksum ? "ready" : "planned")),
      node("p", { class: "k-secret" }, label(file.checksum, "Unavailable")),
      node("p", {}, `Content type: ${label(file.contentType, "Unknown")}`), node("p", {}, `Size: ${formatBytes(Number(file.size))}`),
      node("p", {}, `Cache-Control: ${label(file.cacheControl, "Not set")}`), node("p", {}, `Content-Disposition: ${label(file.contentDisposition, "Not set")}`),
      node("p", {}, `Metadata path: ${label(reference.metadataHref, "")}`),
      node("div", { class: "actions" }, ...sample, copy),
      node("h3", {}, "Reference JSON"), node("pre", {}, JSON.stringify(reference, null, 2)),
      node("h3", {}, "Metadata"), node("pre", {}, JSON.stringify(file.metadata ?? {}, null, 2)));
  } else detail.push(resourceNotice("Select a file", "Choose a file from the list to inspect checksum, metadata, and its ready-to-use Zelavis file reference."));

  return page(
    flashNotice("Done"),
    ...(enabled ? [] : [resourceNotice("Storage service is not mounted", "Add platform file storage or enable a storage core service to use this panel.")]),
    columns(3, statCard("Files", String(files.length), "Currently visible under this prefix"), statCard("Total size", formatBytes(total), "Sum of the visible files"), statCard("Metadata", selected ? "Ready" : "Select file", "Checksums and file references are available per file")),
    columns(2,
      card("Upload and browse", filter, upload, node("div", { class: "k-card flush" }, ...(rows.length ? rows : [resourceNotice("No files yet", "Upload a file or clear the prefix filter to see more results.")]))),
      card("File details", ...detail)));
});

/** A sample document that carries the file's reference, so the file can be used from the Project's data. */
const insertSample = Effect.fn("ui.insertStorageSample")(function*(scoped: Config, reference: Record<string, unknown>) {
  const api = scoped.api.basePath;
  const tenantId = "zelavis-app";
  yield* request(`${api}/database/documents/collections`, "POST", { tenantId, name: "storage_assets", metadata: { createdBy: "zelavis-dashboard" } }).pipe(Effect.catch(error => error.message.toLowerCase().includes("already") ? Effect.void : Effect.fail(error)));
  const path = label(reference.path, "");
  const title = label(object(reference.metadata).label, path.split("/").filter(Boolean).at(-1) ?? path);
  const inserted = object(yield* request(`${api}/database/documents/storage_assets`, "POST", { tenantId, data: { title, kind: "asset", file: reference } }));
  return label(inserted.id, "");
});

/** Project → Media: the gallery is an island that owns its own state (selection, order, filters). */
export const mediaScreen = Effect.fn("ui.mediaScreen")(function*(context: ScreenContext, scoped: Config) {
  const enabled = array(scoped.services).some(service => object(service).name === "@zelavis/storage") || object(object(scoped.capabilities).storage).available === true;
  const settings = object(yield* request(`${context.config.api.basePath}/runtime/settings`).pipe(Effect.catch(() => Effect.succeed({}))));
  const orderedPaths = array(object(object(settings.preferences).media).orderedPaths).map(String);
  const island = document.createElement("fuzor-island");
  island.setAttribute("src", "media-gallery");
  island.setAttribute("props", JSON.stringify({ apiBase: scoped.api.basePath, controlApi: context.config.api.basePath, orderedPaths }));
  return page(
    node("div", { class: "actions" }, link("Open Backend Storage", `/projects/${encodeURIComponent(context.projectId ?? "")}/storage`)),
    ...(enabled ? [] : [resourceNotice("Storage service is not mounted", "Add platform file storage or enable the storage core service to use the media gallery.")]),
    island);
});
