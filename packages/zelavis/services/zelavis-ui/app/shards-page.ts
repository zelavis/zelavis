import { Effect } from "effect";
import { ApiError, array, label, object, request, type Config } from "./api.ts";
import { button, message, node } from "./dom.ts";
import { formatBytes } from "./storage-pages.ts";
import { card, dataRow, flashNotice, page, resourceNotice, rowsCard, setFlash } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";

const MIB = 2 ** 20;

/** `0-31,64` as `[0, 1, ..., 31, 64]`; refuses a backwards range, an empty list and a number that is not a range. */
const parseRanges = (text: string) => Effect.try({
  try: () => {
    const ranges: number[] = [];
    for (const part of text.split(",").map(each => each.trim()).filter(Boolean)) {
      const match = /^(\d+)(?:-(\d+))?$/.exec(part);
      if (!match) throw new TypeError(`"${part}" is not a range number or a range like 0-31.`);
      const from = Number(match[1]), to = match[2] === undefined ? from : Number(match[2]);
      if (to < from || to - from > 4096) throw new TypeError(`"${part}" is not a usable range.`);
      for (let range = from; range <= to; range += 1) ranges.push(range);
    }
    if (ranges.length === 0) throw new TypeError("Name at least one virtual range.");
    return ranges;
  },
  catch: cause => new ApiError({ message: cause instanceof Error ? cause.message : String(cause) }),
});

/**
 * Where a Project's database shards live: which are on another Node, whether that Node is answering, and the durable place
 * release, and replica operations. A client of the shared shard routes (`database/shards`), the same ones `client.shards` and
 * `zelavis shards` call, and of the Platform's read-only allocation (`runtime/shard-placement`); the page owns no shard state.
 * The operator sets the allocation with `client.shardPlacement` or `zelavis shard-placement`, not here.
 */
export const shardsScreen = Effect.fn("ui.shards")(function*(context: ScreenContext, scoped: Config, projectId: string) {
  const api = `${scoped.api.basePath}/database/shards`;
  const view = object(yield* request(api));
  const shards = array(view.shards).map(object);
  const operation = view.operation ? object(view.operation) : undefined;
  const placement = yield* request(`${context.config.api.basePath}/runtime/shard-placement/${encodeURIComponent(projectId)}`).pipe(
    Effect.map(object), Effect.catch(() => Effect.succeed(undefined)));
  const allocation = placement?.allocation ? object(placement.allocation) : undefined;
  const permissions = array(object(object(scoped.access).principal).permissions);
  const canManage = scoped.access === undefined || permissions.includes("*") || permissions.includes("database.shards.manage") || permissions.includes("project.runtime.manage");
  const running = operation !== undefined && operation.phase !== "done" && operation.phase !== "failed";
  const act = (effect: Effect.Effect<unknown, ApiError>, text: string) => context.run(effect, () => { setFlash(text); context.refresh(); });

  const locals = shards.filter(shard => shard.location === "local").map(shard => label(shard.shardId, ""));
  const controls: Record<string, string> = running ? { disabled: "" } : {};
  const placements = array(placement?.placements).map(object);
  const rows = shards.map(shard => {
    const id = label(shard.shardId, ""), remote = shard.location === "remote";
    const path = `${api}/${encodeURIComponent(id)}`;
    const where = remote ? `on ${label(shard.nodeId, "another Node")} · ${label(shard.state, "unknown")} at epoch ${label(shard.epoch, "?")}${shard.available === false ? " · NOT ANSWERING" : ""}` : "on this Node";
    const replica = shard.replica === undefined ? undefined : object(shard.replica);
    const lag = replica?.lagMillis;
    const copy = replica === undefined ? "" : ` · replica on ${label(replica.nodeId, "another Node")} · ${label(replica.status, "unknown")}${typeof lag === "number" ? ` · ${(lag / 1000).toFixed(1)} s behind` : ""}`;
    const actions = node("div", { class: "actions" });
    if (canManage && replica !== undefined) {
      actions.append(button("Remove replica", () => {
        if (!window.confirm(`Remove the replica of ${id} and release its storage?`)) return;
        act(request(`${path}/unreplicate`, "POST"), `Removing the replica of ${id}.`);
      }, { "aria-label": `Remove the replica of shard ${id}`, ...controls }));
    }
    if (canManage && replica === undefined) {
      const primary = placements.find(entry => entry.shardId === id && entry.role === "primary" && entry.state === "committed");
      const reserved = object(primary?.resources).diskBytes;
      const mib = typeof reserved === "number" && reserved > 0 ? Math.ceil(reserved / MIB) : 8192;
      const disk = node("input", { type: "number", min: "1", value: String(mib), "aria-label": `Replica disk in MiB for ${id}`, ...controls });
      actions.append(node("label", {}, "Replica disk (MiB)", disk), button("Add replica", () => {
        const size = (disk as HTMLInputElement).valueAsNumber;
        if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(size * MIB)) {
          context.run(Effect.fail(new ApiError({ message: size >= 1
            ? "Give the replica a valid whole number of MiB."
            : "Give the replica at least 1 MiB of disk." })));
          return;
        }
        act(request(`${path}/replicate`, "POST", { resources: { diskBytes: size * MIB } }), `Adding a replica of ${id}.`);
      }, { "aria-label": `Add a replica of shard ${id}`, ...controls }));
    }
    if (canManage && remote && replica === undefined) {
      const into = node("select", { "aria-label": `Give ${id} back to`, ...controls }, ...locals.map(local => node("option", { value: local }, local)));
      actions.append(into, button("Release", () => {
        if (!window.confirm(`Move ${id}'s ranges to ${(into as HTMLSelectElement).value} and give the shard back to the Platform?`)) return;
        act(request(`${path}/release`, "POST", { into: (into as HTMLSelectElement).value }), `Releasing ${id}.`);
      }, { "aria-label": `Release shard ${id}`, ...controls }));
    }
    return dataRow(id, `${where} · ${label(shard.virtualRanges, "0")} virtual ranges${copy}`, actions);
  });

  const content: Node[] = [flashNotice("Shard operation started"),
    resourceNotice("Shards on other Nodes", "A shard on another Node holds some of this database's virtual ranges. Placing moves Tenants onto a new shard there, and releasing moves them back; routing changes only after the other Node answers. Eligible Tenant reads run on that Node within a work budget, and a read that asks for more is refused rather than answered in part; similarity queries and writes run through this Project. A Project whose remote shard is not answering still serves its other shards. A replica is a durability copy on another Node. The Project keeps it current from the shard’s log. Tenant reads use the primary, and recovery and promotion require separate support."),
    rowsCard("Shards", ...rows)];
  content.push(operation
    ? card("Latest operation", message(`${label(operation.kind)} ${label(operation.shardId)} · ${label(operation.phase)}${operation.error ? ` · ${label(operation.error)}` : ""}${operation.nodeId ? ` · ${label(operation.nodeId)}` : ""}`, operation.phase === "failed"))
    : card("Latest operation", message("No shard operation yet.")));
  content.push(allocation
    ? card("Allocation", message(`Nodes ${array(allocation.allowedNodeIds).map(each => label(each)).join(", ") || "none"} · ${label(allocation.cpuCores)} CPU · ${formatBytes(Number(allocation.memoryBytes) || 0)} memory · ${formatBytes(Number(allocation.diskBytes) || 0)} disk`))
    : card("Allocation", message("No allocation is set, or you may not view it: remote shards are off for this Project until an operator sets one (zelavis shard-placement set-allocation).")));

  if (canManage) {
    const ranges = node("input", { name: "ranges", placeholder: "0-31,64", "aria-label": "Virtual ranges to place", autocomplete: "off", required: "" });
    const cpu = node("input", { name: "cpu", type: "number", min: "1", value: "1", "aria-label": "CPU cores" });
    const memory = node("input", { name: "memory", type: "number", min: "1", value: "1024", "aria-label": "Memory in MiB" });
    const disk = node("input", { name: "disk", type: "number", min: "1", value: "8192", "aria-label": "Disk in MiB" });
    const form = node("form", { class: "form" },
      node("label", {}, "Virtual ranges", ranges), node("label", {}, "CPU cores", cpu), node("label", {}, "Memory (MiB)", memory), node("label", {}, "Disk (MiB)", disk),
      node("button", { type: "submit", class: "primary", ...(running ? { disabled: "" } : {}) }, "Place on another Node"));
    form.addEventListener("submit", event => {
      event.preventDefault();
      context.run(parseRanges((ranges as HTMLInputElement).value).pipe(Effect.flatMap(virtualRanges => request(api + "/place", "POST", {
        virtualRanges,
        resources: { cpuCores: Number((cpu as HTMLInputElement).value), memoryBytes: Number((memory as HTMLInputElement).value) * MIB, diskBytes: Number((disk as HTMLInputElement).value) * MIB },
      }))), () => { setFlash("Placing the shard."); context.refresh(); });
    });
    content.push(card("Place ranges on a new shard", form));
  }
  return page(...content);
});
