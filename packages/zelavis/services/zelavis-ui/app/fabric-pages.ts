import { Effect } from "effect";
import { ApiError, array, label, object, request } from "./api.ts";
import { CLOUD_PROVIDERS, describeScaleOutOutcome, joinCommand, newRequestId } from "./capacity.ts";
import { button, field, node } from "./dom.ts";
import { badge, card, dataRow, columns, page, resourceNotice, rowsCard, statCard } from "./page-kit.ts";
import type { ScreenContext } from "./screens.ts";
import { dropdown } from "./dropdown.ts";

/** Server → Fabric: the control plane's placements, nodes, data fabric, infrastructure and policy. */

type Row = readonly [label: string, detail: string, state?: string];
interface Panel { title: string; description: string; rows: readonly Row[]; notice: readonly [string, string] }

const FEATURES: Record<string, string> = {
  projectPlacement: "Project placement",
  multiNode: "Multi-node operation",
  automaticBalancing: "Automatic balancing",
  projectMigration: "Project migration",
  zelavisAppDataPlacement: "Zelavis App data placement",
  replication: "Replication and failover",
  infrastructureAutoscaling: "Infrastructure autoscaling"
};

const panel = (rows: Panel) => page(
  card(undefined, node("h2", {}, rows.title), node("p", {}, rows.description)),
  rowsCard("", ...rows.rows.map(([title, detail, state]) => dataRow(title, detail, state ? badge(state) : undefined))),
  resourceNotice(...rows.notice));

const planned = (...rows: readonly (readonly [string, string])[]): readonly Row[] => rows.map(([title, detail]) => [title, detail, "planned"] as const);

const STATIC: Record<string, Panel> = {
  "data/shards": {
    title: "Zelavis App shards", description: "Shared project databases, shared shard databases, dedicated tenant databases, and eventual intra-tenant shards.",
    rows: planned(["Shared project database", "The simplest default; tenant_id remains the routing and extraction key."], ["Shared shard databases", "Place groups of tenants across multiple SQLite databases."], ["Dedicated tenant databases", "Promote hot or isolated tenants without changing application queries."], ["Intra-tenant shards", "Reserved for tenants that outgrow one database; not an early milestone."]),
    notice: ["Zelavis Apps only", "Fabric does not promise transparent database sharding for WordPress, Drupal, or arbitrary third-party applications."]
  },
  "data/replicas": {
    title: "Database replicas", description: "Replica eligibility, lag, checkpoints, promotion, and single-writer fencing for Zelavis App data.",
    rows: planned(["Replication stream", "Evaluate event-log and WAL-based adapters behind one replication contract."], ["Promotion policy", "Only healthy, caught-up replicas may become the authoritative writer."], ["Failover fencing", "A new placement generation prevents an old writer from accepting writes."]),
    notice: ["Placement is not replication", "The placement map says who is authoritative; replication controls which verified copies can recover or take over."]
  },
  "data/schema-rollouts": {
    title: "Schema rollouts", description: "Versioned, observable schema changes across every shared shard and dedicated tenant database.",
    rows: planned(["Compatibility window", "Prefer expand-and-contract changes while databases are on mixed versions."], ["Per-database progress", "Track pending, running, verified, and failed rollout state."], ["Retry and resume", "Schema work must be idempotent and resumable after node failure."]),
    notice: ["Schema before general sharding", "Safe fleet-wide schema management is required before a large collection of shards and dedicated databases is practical."]
  },
  data: {
    title: "Zelavis App data fabric", description: "The project-aware database layer beneath Zelavis App projects.",
    rows: planned(["Tenant placement", "Route a tenant to shared, sharded, or dedicated physical storage."], ["Database placement", "Compute and database ownership may separate when installations grow."], ["Transparent application routing", "Applications keep using the Zelavis App database API while Fabric chooses storage."]),
    notice: ["One database per user is a policy", "Dedicated tenant databases remain a powerful target, but the physical mode is selected per workload instead of becoming a permanent application-level assumption."]
  },
  "infrastructure/providers": {
    title: "Cloud and server provider connections", description: "Optional provider plugins can provision Fabric nodes; manually managed servers remain first-class.",
    rows: [["Manual / self-managed servers", "Enroll existing VPS, bare-metal, or private-cloud machines without a provider account.", "available"], ...planned(["Hetzner Cloud", "Connection placeholder: API token, project, network, location, and server profile."], ["DigitalOcean", "Connection placeholder: token, project, region, VPC, and Droplet profile."], ["AWS", "Connection placeholder: credentials, account, region, VPC, subnet, and instance profile."], ["Azure / Google Cloud / Vultr", "Provider plugins use the same node provisioning and termination contract."], ["Custom infrastructure provider", "A provider contract supports private clouds and future community integrations."])],
    notice: ["Credentials stay provider-owned", "Fabric consumes provider capabilities and connection status; secrets, SDK calls, and vendor-specific configuration live in provider plugins and the System Store."]
  },
  "infrastructure/autoscaling": {
    title: "Infrastructure autoscaling", description: "Provision or remove machines only after Fabric has exhausted safe placement options on existing nodes.",
    rows: planned(["Scale-out trigger", "Sustained capacity pressure and placement headroom—not a momentary spike."], ["Node preparation", "Provision, enroll, attest, label, and verify capacity before placement."], ["Scale-in safety", "Drain placements and replicas before a provider may terminate a node."]),
    notice: ["Autoscaling is optional", "A fully self-managed cluster uses the complete Fabric without connecting any cloud provider."]
  },
  infrastructure: {
    title: "Infrastructure", description: "Node enrollment, provider connections, capacity pools, and optional infrastructure autoscaling.",
    rows: [["Self-managed pool", "Existing machines enrolled through the Zelavis node agent.", "available"], ...planned(["Provider-managed pools", "Cloud or VPS provider plugins may add capacity when explicitly enabled."], ["Capacity profiles", "Reusable CPU, memory, disk, region, and role requirements for new nodes."])],
    notice: ["Provider-neutral core", "Fabric never depends on AWS, Kubernetes, or another provider. Provider-specific behavior stays behind optional plugin boundaries."]
  },
  "settings/placement-policies": {
    title: "Placement policies", description: "Constraints and preferences used by the scheduler for all project kinds and Zelavis App data.",
    rows: planned(["Node labels and affinity", "Prefer or require regions, storage classes, roles, and project-specific labels."], ["Failure-domain spread", "Keep replicas and recoverable copies away from the same host or zone."], ["Dedicated tenant threshold", "Promote eligible Zelavis App tenants based on load, size, or isolation policy."]),
    notice: ["Policy proposes; placement decides", "Consistent hashing and scheduler scores may propose a destination, but the durable placement map remains authoritative."]
  },
  "settings/networking": {
    title: "Fabric networking", description: "Private node communication and project traffic routing inside the Zelavis installation.",
    rows: planned(["Agent endpoint", "Mutually authenticated control and data transfer channel for enrolled nodes."], ["Internal routing", "Resolve project placement and balance requests among eligible runtime replicas."], ["Internet ingress", "External DNS, anycast, or edge routing remains a separate provider concern."]),
    notice: ["Built-in workload routing", "Fabric should load-balance Zelavis-owned workloads without requiring a paid managed application load balancer, while still integrating with external ingress."]
  },
  "settings/limits": {
    title: "Limits and safety", description: "Bound balancing work and prevent automated recovery from destabilizing the cluster.",
    rows: planned(["Migration concurrency", "Cap simultaneous project and tenant-data moves globally and per node."], ["Cooldown and hysteresis", "Require sustained pressure and time between automatic placement changes."], ["Capacity reserves", "Keep explicit CPU, memory, disk, I/O, and network headroom for recovery."]),
    notice: ["Automation needs brakes", "The balancer must never create an unbounded migration queue or remove the last healthy recovery copy."]
  },
  settings: {
    title: "Fabric settings", description: "Cluster-wide placement, networking, safety, and scheduling policy.",
    rows: planned(["Placement policies", "Affinity, regions, failure domains, and tenant isolation thresholds."], ["Networking", "Node-agent trust, internal traffic routing, and ingress boundaries."], ["Limits and safety", "Migration bounds, cooldowns, capacity reserves, and automatic-action gates."]),
    notice: ["System-scoped configuration", "Fabric settings belong to the Platform OS and System Store; they are never stored in or exposed through a project's app database."]
  },
  backups: {
    title: "Fabric backups and recovery", description: "Logical project and data backup identity independent of the machine currently hosting it.",
    rows: planned(["Project backup manifests", "Each project driver describes runtime state, files, databases, and provider references."], ["Zelavis App data snapshots", "Include shards, tenant databases, event checkpoints, and placement generations."], ["Cross-node restore", "Restore to a verified destination and activate through a new placement generation."]),
    notice: ["Recovery reuses placement machinery", "A restore is complete only after verification, generation commit, and safe traffic activation on the destination."]
  },
  observability: {
    title: "Fabric observability", description: "Topology, decisions, health, pressure, migrations, replication lag, and recovery state.",
    rows: planned(["Placement explanations", "Show selected node, generation, constraints, scores, and rejected alternatives."], ["Node and workload pressure", "CPU, memory, disk, I/O, network, requests, jobs, and database write pressure."], ["Migration and replication telemetry", "Bytes, duration, retries, failures, checkpoints, and replica lag."]),
    notice: ["Every decision must be explainable", "Operators should be able to answer why a project moved, why a node was chosen, and what prevents a migration from committing."]
  }
};

const when = (timestamp: unknown) => new Date(Number(timestamp)).toLocaleString();

/** Why a section could not be read, in words for the person looking at it. */
const reason = (error: ApiError) => error.status === 403 ? "Your account does not have permission to see this." : error.status === 503 ? "This installation was not started with this capability." : error.message;

const nodesPage = Effect.fn("ui.fabricNodes")(function*(context: ScreenContext) {
  const api = `${context.config.api.basePath}/runtime/nodes`;
  const loaded = yield* Effect.all([request(api), request(`${api}/platform`)]).pipe(Effect.result);
  if (loaded._tag === "Failure") return page(resourceNotice("Nodes are not available", reason(loaded.failure)));
  const list = object(loaded.success[0]);
  const platform = object(object(loaded.success[1]).endpoint);
  const hasPlatform = typeof platform.url === "string" && typeof platform.fingerprint === "string";
  const nodes = array(list.nodes).map(object);
  const pending = array(list.enrollments).map(object).filter(enrollment => enrollment.state === "unused");

  const nodeRows = nodes.map(entry => {
    const active = entry.state === "active";
    const behind = entry.compatibility === "behind";
    const controls = [badge(active ? (behind ? "degraded" : "active") : "unavailable"),
      ...(active ? [button("Revoke", () => context.run(request(`${api}/${encodeURIComponent(label(entry.nodeId, ""))}`, "DELETE"), () => context.refresh()))] : [])];
    return dataRow(label(entry.nodeId), `${label(entry.url)} · ${label(entry.version, "unknown version")}${behind ? " · behind this Platform" : ""} · enrolled ${when(entry.enrolledAt)}`, node("span", { class: "actions" }, ...controls));
  });
  const pendingRows = pending.map(enrollment => dataRow(label(enrollment.nodeId), `${enrollment.origin === "cloud" ? "Requested through the cloud" : "Waiting for the machine to join"} · expires ${when(enrollment.expiresAt)}`, badge("provisioning")));

  const issued = node("div", { hidden: "" });
  const nodeField = field("nodeId", "Node id, for example worker-1");
  const form = node("form", { class: "k-inline" }, nodeField, node("button", { type: "submit", class: "primary" }, "Create join command"));
  form.addEventListener("submit", event => {
    event.preventDefault();
    const nodeId = String(new FormData(form).get("nodeId") ?? "").trim();
    context.run(request(`${api}/enrollments`, "POST", { nodeId }), result => {
      const token = object(result);
      issued.hidden = false;
      issued.replaceChildren(
        node("p", {}, `Run on ${label(token.nodeId)} (expires ${when(token.expiresAt)}). This is the only time the token is shown.`),
        node("pre", { "data-testid": "join-command" }, joinCommand({ platform: { url: String(platform.url), fingerprint: String(platform.fingerprint) }, nodeId: label(token.nodeId, ""), token: label(token.token, "") })));
    });
  });

  return page(
    rowsCard("Fabric nodes", ...(nodeRows.length || pendingRows.length ? [...nodeRows, ...pendingRows] : [dataRow("No nodes enrolled", "Add a machine below. This Platform keeps running Projects itself until one joins.")])),
    card("Add a machine you manage",
      node("p", {}, "Install the worker role on the machine, then run the command shown here as root. The token works once."),
      hasPlatform ? form : resourceNotice("This installation does not accept nodes yet", "Start it with an enrollment port (zelavis serve --enrollment-port) so machines have somewhere to join."),
      issued));
});

const cloudPage = Effect.fn("ui.fabricCloud")(function*(context: ScreenContext) {
  const api = `${context.config.api.basePath}/runtime/cloud`;
  const read = Effect.gen(function*() {
    const connection = object(yield* request(api)).connection;
    const connected = connection !== null && connection !== undefined;
    const machines = connected ? array(object(yield* request(`${api}/nodes`)).nodes) : [];
    const scaling = connected ? object(object(yield* request(`${api}/scaling`)).scaling) : null;
    return { connection: connected ? object(connection) : null, machines: machines.map(object), scaling };
  });
  const loaded = yield* read.pipe(Effect.result);
  if (loaded._tag === "Failure") return page(resourceNotice("Cloud capacity is not available", reason(loaded.failure)));
  const { connection, machines, scaling } = loaded.success;
  const refresh = () => context.refresh();
  const sections: HTMLElement[] = [];

  if (connection) {
    sections.push(rowsCard("Cloud provider", dataRow(`${label(connection.label)} (${label(connection.provider)})`, `Token ending ${label(connection.tokenHint)} · connected ${when(connection.connectedAt)} by ${label(connection.connectedBy)}`,
      (() => { const disconnect = button("Disconnect", () => context.run(request(`${api}/connection`, "DELETE"), refresh)); if (machines.length) disconnect.setAttribute("disabled", ""); return disconnect; })())));
  } else {
    const provider = dropdown({ name: "provider", label: "Provider" }, CLOUD_PROVIDERS.map(entry => ({ value: entry.id, label: entry.label })));
    const form = node("form", { class: "form" },
      node("p", {}, "The token can create and delete machines in its cloud project, so use a token from a dedicated project. It is stored encrypted, never shown again, and every use is audited."),
      provider, node("input", { name: "label", placeholder: "Label (optional)", "aria-label": "Label" }), node("input", { name: "token", type: "password", autocomplete: "off", placeholder: "API token", required: "", "aria-label": "API token" }),
      node("button", { type: "submit", class: "primary" }, "Connect"));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(form);
      const text = (key: string) => String(data.get(key) ?? "").trim();
      context.run(request(`${api}/connection`, "POST", { provider: text("provider"), token: text("token"), ...(text("label") ? { label: text("label") } : {}) }), refresh);
    });
    sections.push(card("Cloud provider", node("p", {}, "Optional. Connecting a provider lets Zelavis create and delete worker machines in it. Existing servers keep working without one."), form));
  }

  if (connection && scaling) {
    const settings = object(scaling.settings);
    const consent = node("input", { type: "checkbox", name: "consent", ...(settings.consent === true ? { checked: "" } : {}) });
    const form = node("form", { class: "filters" },
      node("label", {}, consent, node("span", {}, "Allow Zelavis to spend money on machines")),
      node("label", {}, node("span", {}, "At most (machines)"), node("input", { name: "maxMachines", type: "number", min: "1", max: "20", value: label(settings.maxMachines, "1"), "aria-label": "Maximum machines" })),
      node("label", {}, node("span", {}, "Minutes between requests"), node("input", { name: "cooldownMinutes", type: "number", min: "1", max: "1440", value: label(settings.cooldownMinutes, "10"), "aria-label": "Minutes between requests" })),
      node("button", { type: "submit", class: "primary" }, "Save"));
    form.addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(form);
      context.run(request(`${api}/scaling`, "PUT", { consent: consent.checked, maxMachines: Number(data.get("maxMachines")), cooldownMinutes: Number(data.get("cooldownMinutes")) }), refresh);
    });
    sections.push(card("Automatic scale-out",
      node("p", {}, "Off by default. When on, Zelavis requests one machine at a time, and only after Projects have stayed unplaceable for lack of capacity for a couple of minutes. It never deletes machines by itself, and each request is audited."),
      form,
      node("p", { class: "muted", "data-testid": "scale-out-status" }, `${settings.consent === true ? "Automatic scale-out is on. " : "Automatic scale-out is off. "}${describeScaleOutOutcome(typeof object(scaling.last).outcome === "string" ? String(object(scaling.last).outcome) : undefined)}`)));
  }

  if (connection) {
    const region = node("input", { name: "region", placeholder: "Location (optional, per your policy)", "aria-label": "Location" });
    const request_ = button("Request a machine", () => context.run(request(`${api}/nodes`, "POST", { requestId: newRequestId(), ...(region.value.trim() ? { region: region.value.trim() } : {}) }), refresh), { class: "primary" });
    const rows = machines.length
      ? machines.map(machine => dataRow(label(machine.id), typeof machine.region === "string" ? `${label(machine.provider)} · ${machine.region}` : label(machine.provider),
        node("span", { class: "actions" }, badge(label(machine.state)), (() => { const release = button("Release", () => context.run(request(`${api}/nodes/${encodeURIComponent(label(machine.id, ""))}`, "DELETE"), refresh)); if (machine.state === "releasing") release.setAttribute("disabled", ""); return release; })())))
      : [dataRow("No machines", "Request one to add a worker that enrolls itself.")];
    sections.push(rowsCard("Machines Zelavis created", ...rows, node("div", { class: "k-row" }, node("div", { class: "actions" }, region, request_))));
  }
  return page(...sections);
});

export const fabricScreen = Effect.fn("ui.fabricScreen")(function*(context: ScreenContext) {
  const parts = context.path.replace(/\/+$/, "").split("/").slice(3);
  const [section, detail] = parts;
  const snapshot = object(yield* request(`${context.config.api.basePath}/fabric/snapshot`));
  const features = object(snapshot.features);
  if (!section) {
    const placements = array(snapshot.projectPlacements);
    return page(
      columns(3,
        statCard("Fabric", label(snapshot.status), `${label(snapshot.mode)} · local node ${label(snapshot.localNodeId)}`),
        statCard("Nodes", String(array(snapshot.nodes).length), "Gateways, control nodes, and project workers."),
        statCard("Project placements", String(placements.length), "All managed project kinds use this placement layer."),
        statCard("Migrations", String(array(snapshot.migrations).length), "Durable project and Zelavis App data moves.")),
      card("Capability status", node("p", {}, "The first version exposes the honest single-node control-plane model while preserving the contracts needed for a cluster.")),
      rowsCard("", ...Object.entries(features).map(([feature, state]) => dataRow(FEATURES[feature] ?? feature, feature === "zelavisAppDataPlacement" ? "Tenant-aware database placement applies only to Zelavis App projects." : "Platform-wide Fabric capability.", badge(label(state))))),
      resourceNotice("One fabric, two depths", "Fabric places and routes every managed project type. Only Zelavis App projects opt into the deeper tenant, shard, replica, and schema-rollout data fabric."));
  }
  if (section === "nodes") return yield* nodesPage(context);
  if (section === "infrastructure" && detail === "providers") return yield* cloudPage(context);
  if (section === "placements") {
    const rows: Row[] = array(snapshot.projectPlacements).map(object).map(placement => [label(object(placement.identity).workloadId), `${label(placement.projectKind)} · runtime ${label(placement.runtimeNodeId)} · generation ${label(placement.generation)}`, label(placement.state)] as const);
    return panel({ title: "Project placements", description: "The authoritative project-to-node map for Zelavis Apps, WordPress, Drupal, static sites, and generic managed projects.", rows: rows.length ? rows : [["No projects placed", "Projects will appear here as soon as the Platform creates them.", "ready"]], notice: ["Generations fence stale owners", "A placement move will commit a new authoritative generation only after the destination is prepared and verified."] });
  }
  if (section === "migrations") {
    const rows: Row[] = array(snapshot.migrations).map(object).map(migration => [label(migration.id), `${label(migration.scope)} · ${label(migration.projectId)} · ${label(migration.sourceNodeId)} → ${label(migration.destinationNodeId)}`, label(migration.state)] as const);
    return panel({ title: "Fabric migrations", description: "Durable, resumable moves for whole projects and Zelavis App tenant data.", rows: rows.length ? rows : [["No migrations", "The local single-node Fabric has no movement work queued.", "ready"]], notice: ["Migration is a workflow", "Prepare, copy, catch up, fence, commit, verify, and clean up must be durable steps—not an uncoordinated file copy."] });
  }
  if (section === "balancing") return panel({ title: "Scheduling and balancing", description: "Explainable placement decisions across current Fabric capacity.", rows: [["Capacity scoring", "CPU, memory, disk, I/O, network, SQLite write pressure, and job pressure.", label(features.automaticBalancing, "planned")], ...planned(["Bounded rebalance queue", "Prioritized moves with concurrency limits, cooldowns, and migration cost."], ["Decision explanations", "Record why a destination was selected and which constraints were applied."])], notice: ["Stability before utilization", "Balancing should preserve recovery headroom and avoid thrashing even when a denser placement looks possible."] });
  if (section === "replication") return panel({ title: "Replication and failover", description: "Recovery copies, replica health, promotion eligibility, and fenced ownership changes.", rows: [...planned(["Project recovery copies", "Project-kind drivers declare what can be replicated and how it is restored."]), ["Zelavis App database replicas", "Track checkpoints and lag for shared shards and dedicated tenant databases.", label(features.replication, "planned")], ...planned(["Failover workflow", "Select, verify, promote, commit a new generation, then route traffic."])], notice: ["Single authoritative writer", "Failover must prove that stale owners cannot keep writing before a replica is promoted."] });
  const known = STATIC[detail ? `${section}/${detail}` : section] ?? STATIC[section];
  if (known) return panel(known);
  return panel({ title: "Fabric area", description: "This Fabric route is not registered in the current navigation model.", rows: [[section, detail ? `Requested detail: ${detail}` : "No detail selected.", "planned"]], notice: ["Unknown Fabric route", "Use the Fabric submenu to open a route-backed control-plane area."] });
});
