import { Effect } from "effect";
import { array, label, object, request, type Config } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { formatBytes } from "./storage-pages.ts";
import { card, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash } from "./page-kit.ts";
import { backupSchedulesPanel } from "./backup-schedules-panel.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * Database images: physical backups of the whole Project database on its host. A client of the shared image routes
 * (`maintenance/images`), the same ones the SDK and `zelavis projects images|create-image|verify-image|delete-image|
 * prune-images` call; the page owns no image state. Restoring an image is the operator's act with the Project stopped,
 * so there is nothing here for it.
 */
export const databaseImagesScreen = Effect.fn("ui.databaseImages")(function*(context: ScreenContext, scoped: Config) {
  const api = `${scoped.api.basePath}/database/maintenance/images`;
  const images = array(object(yield* request(api)).images).map(object);
  const act = (effect: Effect.Effect<unknown, unknown>, done: (result: unknown) => string) =>
    context.run(effect as Effect.Effect<unknown, never>, result => { setFlash(done(result)); context.refresh(); });

  const rows = images.map(image => {
    const name = label(image.name, "");
    const shards = array(image.shards).length;
    return dataRow(name, `${label(image.engine)} · ${shards} ${shards === 1 ? "shard" : "shards"} · ${label(image.keys, "0")} keys · ${formatBytes(Number(image.bytes) || 0)} · ${label(image.createdAt)}`,
      node("div", { class: "actions" },
        button("Verify", () => act(request(`${api}/${encodeURIComponent(name)}/verify`, "POST", {}), result => {
          const verification = object(result);
          const failed = array(verification.shards).map(object).filter(shard => shard.ok !== true);
          return verification.ok === true ? `Image ${name} holds exactly what was written.`
            : `Image ${name} differs from what was written: ${failed.map(shard => `${label(shard.shard)} (${label(shard.problem)})`).join(", ")}.`;
        }), { "aria-label": `Verify image ${name}` }),
        button("Delete", () => {
          if (window.prompt(`Type ${name} to delete this image for good.`) !== name) return;
          act(request(`${api}/${encodeURIComponent(name)}`, "DELETE", { confirm: name }), () => `Deleted image ${name}.`);
        }, { class: "danger", "aria-label": `Delete image ${name}` })));
  });

  const nameInput = node("input", { name: "name", placeholder: "nightly-2026-10-30", "aria-label": "Image name", autocomplete: "off", required: "", maxlength: "64" });
  const engine = node("select", { name: "engine", "aria-label": "Image engine" },
    node("option", { value: "" }, "The database's own engine"), node("option", { value: "sqlite" }, "sqlite"),
    node("option", { value: "lmdb" }, "lmdb"), node("option", { value: "rocksdb" }, "rocksdb"));
  const create = node("form", { class: "form" },
    node("label", {}, node("span", {}, "Name"), nameInput), node("label", {}, node("span", {}, "Engine"), engine),
    node("button", { type: "submit", class: "primary" }, "Create image"));
  create.addEventListener("submit", event => {
    event.preventDefault();
    const name = nameInput.value.trim();
    act(request(api, "POST", { name, ...(engine.value ? { engine: engine.value } : {}) }), () => `Created image ${name}.`);
  });

  const keep = node("input", { name: "keep", type: "number", min: "1", max: "1000", value: context.url.searchParams.get("keep") ?? "7", "aria-label": "Images to keep" });
  const prune = node("form", { class: "form" },
    node("label", {}, node("span", {}, "Keep the newest"), keep),
    node("button", { type: "submit", class: "danger" }, "Remove older images"));
  prune.addEventListener("submit", event => {
    event.preventDefault();
    const count = Number(keep.value);
    if (!window.confirm(`Remove every image but the newest ${count}?`)) return;
    act(request(`${api}/prune`, "POST", { keep: count }), result => {
      const removed = array(object(result).removed);
      return removed.length === 0 ? "No image was removed." : `Removed ${removed.map(entry => label(entry)).join(", ")}.`;
    });
  });

  // What a returned commit survives, chosen for the Project's next start.
  const storage = object(yield* request(`${scoped.api.basePath}/database/maintenance/storage`).pipe(Effect.orElseSucceed(() => ({}))));
  const durability = node("select", { name: "durability", "aria-label": "Storage durability" },
    node("option", { value: "crash", ...(String(storage.pending ?? storage.durability) === "crash" ? { selected: "" } : {}) }, "Survive a crash (default)"),
    node("option", { value: "power", ...(String(storage.pending ?? storage.durability) === "power" ? { selected: "" } : {}) }, "Survive a power cut (a device flush per commit)"));
  const durabilityForm = node("form", { class: "form" },
    node("p", { class: "muted" }, `${label(storage.engine, "?")} · running with ${label(storage.durability, "?")}${storage.pending ? ` · ${label(storage.pending)} from the next start` : ""}`),
    node("label", {}, node("span", {}, "Durability"), durability),
    node("button", { type: "submit" }, "Save durability"));
  durabilityForm.addEventListener("submit", event => {
    event.preventDefault();
    act(request(`${scoped.api.basePath}/database/maintenance/storage`, "PUT", { durability: durability.value }), result =>
      object(result).pending ? `Durability ${label(object(result).pending)} takes effect when the Project next starts.` : `Durability is ${label(object(result).durability)}.`);
  });
  const offsite = yield* backupSchedulesPanel(`${scoped.api.basePath}/database/maintenance/backup-schedules`, `${scoped.api.basePath}/database/maintenance/backup-runs`, act);

  return page(flashNotice("Images updated"),
    resourceNotice("Whole-database backups", "An image copies every shard into a new directory on this host, from one snapshot per shard, and records a digest of each so Verify can tell whether it still holds exactly what was written. Restoring one replaces the live database and is done with the Project stopped. Opening an image as a database writes to it, so verify it first."),
    rows.length ? rowsCard("Images", ...rows) : card(undefined, message("No images yet.")),
    card("Create an image", create),
    card("Retention", prune),
    card("Storage durability", durabilityForm),
    resourceNotice("Scheduled off-site backups", "Each run captures the database, the Project's runtime store and its media, packed and encrypted with the schedule's own key (AES-256-GCM), and written to the target as objects that are never overwritten, its manifest last. Keep the recovery key shown at creation off this host."),
    ...offsite);
});
