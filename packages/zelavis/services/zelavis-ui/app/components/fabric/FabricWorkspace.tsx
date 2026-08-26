import {
  Activity,
  ArrowRightLeft,
  Cloud,
  Database,
  Gauge,
  HardDriveDownload,
  Network,
  Orbit,
  Route,
  Scale,
  Server,
  Settings2,
  ShieldCheck,
  Waypoints,
} from "lucide-react";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import type { FabricSnapshot } from "#/lib/runtime-api";

interface FabricWorkspaceProps {
  snapshot: FabricSnapshot;
  section?: string;
  detail?: string;
}

interface PlaceholderRow {
  label: string;
  detail: string;
  state?: string;
}

interface PlaceholderPanelProps {
  icon: typeof Server;
  title: string;
  description: string;
  rows: readonly PlaceholderRow[];
  noticeTitle: string;
  noticeDescription: string;
}

const featureLabels: Record<keyof FabricSnapshot["features"], string> = {
  projectPlacement: "Project placement",
  multiNode: "Multi-node operation",
  automaticBalancing: "Automatic balancing",
  projectMigration: "Project migration",
  zelavisAppDataPlacement: "Zelavis App data placement",
  replication: "Replication and failover",
  infrastructureAutoscaling: "Infrastructure autoscaling",
};

function PlaceholderPanel({
  icon: Icon,
  title,
  description,
  rows,
  noticeTitle,
  noticeDescription,
}: PlaceholderPanelProps) {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Icon className="size-4" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {rows.map((row) => (
            <DataRow
              key={row.label}
              label={row.label}
              detail={row.detail}
              meta={row.state ? <StatusBadge state={row.state} /> : undefined}
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title={noticeTitle}
        description={noticeDescription}
      />
    </section>
  );
}

function FabricOverview({ snapshot }: { snapshot: FabricSnapshot }) {
  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Fabric"
          value={snapshot.status}
          detail={`${snapshot.mode} · local node ${snapshot.localNodeId}`}
          icon={Waypoints}
        />
        <StatCard
          label="Nodes"
          value={`${snapshot.nodes.length}`}
          detail="Gateways, control nodes, and project workers."
          icon={Server}
        />
        <StatCard
          label="Project placements"
          value={`${snapshot.projectPlacements.length}`}
          detail="All managed project kinds use this placement layer."
          icon={Route}
        />
        <StatCard
          label="Migrations"
          value={`${snapshot.migrations.length}`}
          detail="Durable project and Zelavis App data moves."
          icon={ArrowRightLeft}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Orbit className="size-4" />
            Capability status
          </CardTitle>
          <CardDescription>
            The first version exposes the honest single-node control-plane model
            while preserving the contracts needed for a cluster.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {Object.entries(snapshot.features).map(([feature, state]) => (
            <DataRow
              key={feature}
              label={featureLabels[feature as keyof FabricSnapshot["features"]]}
              detail={
                feature === "zelavisAppDataPlacement"
                  ? "Tenant-aware database placement applies only to Zelavis App projects."
                  : "Platform-wide Fabric capability."
              }
              meta={<StatusBadge state={state} />}
            />
          ))}
        </CardContent>
      </Card>

      <ResourceNotice
        title="One fabric, two depths"
        description="Fabric places and routes every managed project type. Only Zelavis App projects opt into the deeper tenant, shard, replica, and schema-rollout data fabric."
      />
    </section>
  );
}

function NodesPanel({ snapshot }: { snapshot: FabricSnapshot }) {
  return (
    <PlaceholderPanel
      icon={Server}
      title="Fabric nodes"
      description="Registered machines and the roles they can perform."
      rows={snapshot.nodes.map((node) => ({
        label: node.id,
        detail: `${node.roles.join(", ")} · ${node.runtimeDriver ?? "runtime driver unknown"}${node.runtimeEngine ? ` · ${node.runtimeEngine}` : ""}`,
        state: node.status,
      }))}
      noticeTitle="Node enrollment is next"
      noticeDescription="Remote node identity, heartbeats, capacity reporting, draining, and encrypted agent communication will extend this inventory without changing project placement contracts."
    />
  );
}

function PlacementsPanel({ snapshot }: { snapshot: FabricSnapshot }) {
  const rows = snapshot.projectPlacements.map((placement) => ({
    label: placement.projectId,
    detail: `${placement.projectKind} · node ${placement.nodeId} · generation ${placement.generation}`,
    state: placement.state,
  }));

  return (
    <PlaceholderPanel
      icon={Route}
      title="Project placements"
      description="The authoritative project-to-node map for Zelavis Apps, WordPress, Drupal, static sites, and generic managed projects."
      rows={
        rows.length > 0
          ? rows
          : [
              {
                label: "No projects placed",
                detail: "Projects will appear here as soon as the Platform creates them.",
                state: "ready",
              },
            ]
      }
      noticeTitle="Generations fence stale owners"
      noticeDescription="A placement move will commit a new authoritative generation only after the destination is prepared and verified."
    />
  );
}

function MigrationsPanel({ snapshot }: { snapshot: FabricSnapshot }) {
  const rows = snapshot.migrations.map((migration) => ({
    label: migration.id,
    detail: `${migration.scope} · ${migration.projectId} · ${migration.sourceNodeId} → ${migration.destinationNodeId}`,
    state: migration.state,
  }));

  return (
    <PlaceholderPanel
      icon={ArrowRightLeft}
      title="Fabric migrations"
      description="Durable, resumable moves for whole projects and Zelavis App tenant data."
      rows={
        rows.length > 0
          ? rows
          : [
              {
                label: "No migrations",
                detail: "The local single-node Fabric has no movement work queued.",
                state: "ready",
              },
            ]
      }
      noticeTitle="Migration is a workflow"
      noticeDescription="Prepare, copy, catch up, fence, commit, verify, and clean up must be durable steps—not an uncoordinated file copy."
    />
  );
}

function DataFabricPanel({ detail }: { detail?: string }) {
  if (detail === "shards") {
    return (
      <PlaceholderPanel
        icon={Database}
        title="Zelavis App shards"
        description="Shared project databases, shared shard databases, dedicated tenant databases, and eventual intra-tenant shards."
        rows={[
          {
            label: "Shared project database",
            detail: "The simplest default; tenant_id remains the routing and extraction key.",
            state: "planned",
          },
          {
            label: "Shared shard databases",
            detail: "Place groups of tenants across multiple SQLite databases.",
            state: "planned",
          },
          {
            label: "Dedicated tenant databases",
            detail: "Promote hot or isolated tenants without changing application queries.",
            state: "planned",
          },
          {
            label: "Intra-tenant shards",
            detail: "Reserved for tenants that outgrow one database; not an early milestone.",
            state: "planned",
          },
        ]}
        noticeTitle="Zelavis Apps only"
        noticeDescription="Fabric does not promise transparent database sharding for WordPress, Drupal, or arbitrary third-party applications."
      />
    );
  }

  if (detail === "replicas") {
    return (
      <PlaceholderPanel
        icon={ShieldCheck}
        title="Database replicas"
        description="Replica eligibility, lag, checkpoints, promotion, and single-writer fencing for Zelavis App data."
        rows={[
          {
            label: "Replication stream",
            detail: "Evaluate event-log and WAL-based adapters behind one replication contract.",
            state: "planned",
          },
          {
            label: "Promotion policy",
            detail: "Only healthy, caught-up replicas may become the authoritative writer.",
            state: "planned",
          },
          {
            label: "Failover fencing",
            detail: "A new placement generation prevents an old writer from accepting writes.",
            state: "planned",
          },
        ]}
        noticeTitle="Placement is not replication"
        noticeDescription="The placement map says who is authoritative; replication controls which verified copies can recover or take over."
      />
    );
  }

  if (detail === "schema-rollouts") {
    return (
      <PlaceholderPanel
        icon={Database}
        title="Schema rollouts"
        description="Versioned, observable schema changes across every shared shard and dedicated tenant database."
        rows={[
          {
            label: "Compatibility window",
            detail: "Prefer expand-and-contract changes while databases are on mixed versions.",
            state: "planned",
          },
          {
            label: "Per-database progress",
            detail: "Track pending, running, verified, and failed rollout state.",
            state: "planned",
          },
          {
            label: "Retry and resume",
            detail: "Schema work must be idempotent and resumable after node failure.",
            state: "planned",
          },
        ]}
        noticeTitle="Schema before general sharding"
        noticeDescription="Safe fleet-wide schema management is required before a large collection of shards and dedicated databases is practical."
      />
    );
  }

  return (
    <PlaceholderPanel
      icon={Database}
      title="Zelavis App data fabric"
      description="The project-aware database layer beneath Zelavis App projects."
      rows={[
        {
          label: "Tenant placement",
          detail: "Route a tenant to shared, sharded, or dedicated physical storage.",
          state: "planned",
        },
        {
          label: "Database placement",
          detail: "Compute and database ownership may separate when installations grow.",
          state: "planned",
        },
        {
          label: "Transparent application routing",
          detail: "Applications keep using the Zelavis App database API while Fabric chooses storage.",
          state: "planned",
        },
      ]}
      noticeTitle="One database per user is a policy"
      noticeDescription="Dedicated tenant databases remain a powerful target, but the physical mode is selected per workload instead of becoming a permanent application-level assumption."
    />
  );
}

function InfrastructurePanel({ detail }: { detail?: string }) {
  if (detail === "providers") {
    return (
      <PlaceholderPanel
        icon={Cloud}
        title="Cloud and server provider connections"
        description="Optional provider plugins can provision Fabric nodes; manually managed servers remain first-class."
        rows={[
          {
            label: "Manual / self-managed servers",
            detail: "Enroll existing VPS, bare-metal, or private-cloud machines without a provider account.",
            state: "available",
          },
          {
            label: "Hetzner Cloud",
            detail: "Connection placeholder: API token, project, network, location, and server profile.",
            state: "planned",
          },
          {
            label: "DigitalOcean",
            detail: "Connection placeholder: token, project, region, VPC, and Droplet profile.",
            state: "planned",
          },
          {
            label: "AWS",
            detail: "Connection placeholder: credentials, account, region, VPC, subnet, and instance profile.",
            state: "planned",
          },
          {
            label: "Azure / Google Cloud / Vultr",
            detail: "Provider plugins use the same node provisioning and termination contract.",
            state: "planned",
          },
          {
            label: "Custom infrastructure provider",
            detail: "A provider contract supports private clouds and future community integrations.",
            state: "planned",
          },
        ]}
        noticeTitle="Credentials stay provider-owned"
        noticeDescription="Fabric consumes provider capabilities and connection status; secrets, SDK calls, and vendor-specific configuration live in provider plugins and the System Store."
      />
    );
  }

  if (detail === "autoscaling") {
    return (
      <PlaceholderPanel
        icon={Gauge}
        title="Infrastructure autoscaling"
        description="Provision or remove machines only after Fabric has exhausted safe placement options on existing nodes."
        rows={[
          {
            label: "Scale-out trigger",
            detail: "Sustained capacity pressure and placement headroom—not a momentary spike.",
            state: "planned",
          },
          {
            label: "Node preparation",
            detail: "Provision, enroll, attest, label, and verify capacity before placement.",
            state: "planned",
          },
          {
            label: "Scale-in safety",
            detail: "Drain placements and replicas before a provider may terminate a node.",
            state: "planned",
          },
        ]}
        noticeTitle="Autoscaling is optional"
        noticeDescription="A fully self-managed cluster uses the complete Fabric without connecting any cloud provider."
      />
    );
  }

  return (
    <PlaceholderPanel
      icon={Cloud}
      title="Infrastructure"
      description="Node enrollment, provider connections, capacity pools, and optional infrastructure autoscaling."
      rows={[
        {
          label: "Self-managed pool",
          detail: "Existing machines enrolled through the Zelavis node agent.",
          state: "available",
        },
        {
          label: "Provider-managed pools",
          detail: "Cloud or VPS provider plugins may add capacity when explicitly enabled.",
          state: "planned",
        },
        {
          label: "Capacity profiles",
          detail: "Reusable CPU, memory, disk, region, and role requirements for new nodes.",
          state: "planned",
        },
      ]}
      noticeTitle="Provider-neutral core"
      noticeDescription="Fabric never depends on AWS, Kubernetes, or another provider. Provider-specific behavior stays behind optional plugin boundaries."
    />
  );
}

function SettingsPanel({ detail }: { detail?: string }) {
  if (detail === "placement-policies") {
    return (
      <PlaceholderPanel
        icon={Settings2}
        title="Placement policies"
        description="Constraints and preferences used by the scheduler for all project kinds and Zelavis App data."
        rows={[
          {
            label: "Node labels and affinity",
            detail: "Prefer or require regions, storage classes, roles, and project-specific labels.",
            state: "planned",
          },
          {
            label: "Failure-domain spread",
            detail: "Keep replicas and recoverable copies away from the same host or zone.",
            state: "planned",
          },
          {
            label: "Dedicated tenant threshold",
            detail: "Promote eligible Zelavis App tenants based on load, size, or isolation policy.",
            state: "planned",
          },
        ]}
        noticeTitle="Policy proposes; placement decides"
        noticeDescription="Consistent hashing and scheduler scores may propose a destination, but the durable placement map remains authoritative."
      />
    );
  }

  if (detail === "networking") {
    return (
      <PlaceholderPanel
        icon={Network}
        title="Fabric networking"
        description="Private node communication and project traffic routing inside the Zelavis installation."
        rows={[
          {
            label: "Agent endpoint",
            detail: "Mutually authenticated control and data transfer channel for enrolled nodes.",
            state: "planned",
          },
          {
            label: "Internal routing",
            detail: "Resolve project placement and balance requests among eligible runtime replicas.",
            state: "planned",
          },
          {
            label: "Internet ingress",
            detail: "External DNS, anycast, or edge routing remains a separate provider concern.",
            state: "planned",
          },
        ]}
        noticeTitle="Built-in workload routing"
        noticeDescription="Fabric should load-balance Zelavis-owned workloads without requiring a paid managed application load balancer, while still integrating with external ingress."
      />
    );
  }

  if (detail === "limits") {
    return (
      <PlaceholderPanel
        icon={ShieldCheck}
        title="Limits and safety"
        description="Bound balancing work and prevent automated recovery from destabilizing the cluster."
        rows={[
          {
            label: "Migration concurrency",
            detail: "Cap simultaneous project and tenant-data moves globally and per node.",
            state: "planned",
          },
          {
            label: "Cooldown and hysteresis",
            detail: "Require sustained pressure and time between automatic placement changes.",
            state: "planned",
          },
          {
            label: "Capacity reserves",
            detail: "Keep explicit CPU, memory, disk, I/O, and network headroom for recovery.",
            state: "planned",
          },
        ]}
        noticeTitle="Automation needs brakes"
        noticeDescription="The balancer must never create an unbounded migration queue or remove the last healthy recovery copy."
      />
    );
  }

  return (
    <PlaceholderPanel
      icon={Settings2}
      title="Fabric settings"
      description="Cluster-wide placement, networking, safety, and scheduling policy."
      rows={[
        {
          label: "Placement policies",
          detail: "Affinity, regions, failure domains, and tenant isolation thresholds.",
          state: "planned",
        },
        {
          label: "Networking",
          detail: "Node-agent trust, internal traffic routing, and ingress boundaries.",
          state: "planned",
        },
        {
          label: "Limits and safety",
          detail: "Migration bounds, cooldowns, capacity reserves, and automatic-action gates.",
          state: "planned",
        },
      ]}
      noticeTitle="System-scoped configuration"
      noticeDescription="Fabric settings belong to the Platform OS and System Store; they are never stored in or exposed through a project's app database."
    />
  );
}

export function FabricWorkspace({
  snapshot,
  section,
  detail,
}: FabricWorkspaceProps) {
  if (!section) {
    return <FabricOverview snapshot={snapshot} />;
  }

  if (section === "nodes") {
    return <NodesPanel snapshot={snapshot} />;
  }

  if (section === "placements") {
    return <PlacementsPanel snapshot={snapshot} />;
  }

  if (section === "migrations") {
    return <MigrationsPanel snapshot={snapshot} />;
  }

  if (section === "data") {
    return <DataFabricPanel detail={detail} />;
  }

  if (section === "infrastructure") {
    return <InfrastructurePanel detail={detail} />;
  }

  if (section === "settings") {
    return <SettingsPanel detail={detail} />;
  }

  const panels: Record<string, PlaceholderPanelProps> = {
    balancing: {
      icon: Scale,
      title: "Scheduling and balancing",
      description: "Explainable placement decisions across current Fabric capacity.",
      rows: [
        {
          label: "Capacity scoring",
          detail: "CPU, memory, disk, I/O, network, SQLite write pressure, and job pressure.",
          state: snapshot.features.automaticBalancing,
        },
        {
          label: "Bounded rebalance queue",
          detail: "Prioritized moves with concurrency limits, cooldowns, and migration cost.",
          state: "planned",
        },
        {
          label: "Decision explanations",
          detail: "Record why a destination was selected and which constraints were applied.",
          state: "planned",
        },
      ],
      noticeTitle: "Stability before utilization",
      noticeDescription: "Balancing should preserve recovery headroom and avoid thrashing even when a denser placement looks possible.",
    },
    replication: {
      icon: ShieldCheck,
      title: "Replication and failover",
      description: "Recovery copies, replica health, promotion eligibility, and fenced ownership changes.",
      rows: [
        {
          label: "Project recovery copies",
          detail: "Project-kind drivers declare what can be replicated and how it is restored.",
          state: "planned",
        },
        {
          label: "Zelavis App database replicas",
          detail: "Track checkpoints and lag for shared shards and dedicated tenant databases.",
          state: snapshot.features.replication,
        },
        {
          label: "Failover workflow",
          detail: "Select, verify, promote, commit a new generation, then route traffic.",
          state: "planned",
        },
      ],
      noticeTitle: "Single authoritative writer",
      noticeDescription: "Failover must prove that stale owners cannot keep writing before a replica is promoted.",
    },
    backups: {
      icon: HardDriveDownload,
      title: "Fabric backups and recovery",
      description: "Logical project and data backup identity independent of the machine currently hosting it.",
      rows: [
        {
          label: "Project backup manifests",
          detail: "Each project driver describes runtime state, files, databases, and provider references.",
          state: "planned",
        },
        {
          label: "Zelavis App data snapshots",
          detail: "Include shards, tenant databases, event checkpoints, and placement generations.",
          state: "planned",
        },
        {
          label: "Cross-node restore",
          detail: "Restore to a verified destination and activate through a new placement generation.",
          state: "planned",
        },
      ],
      noticeTitle: "Recovery reuses placement machinery",
      noticeDescription: "A restore is complete only after verification, generation commit, and safe traffic activation on the destination.",
    },
    observability: {
      icon: Activity,
      title: "Fabric observability",
      description: "Topology, decisions, health, pressure, migrations, replication lag, and recovery state.",
      rows: [
        {
          label: "Placement explanations",
          detail: "Show selected node, generation, constraints, scores, and rejected alternatives.",
          state: "planned",
        },
        {
          label: "Node and workload pressure",
          detail: "CPU, memory, disk, I/O, network, requests, jobs, and database write pressure.",
          state: "planned",
        },
        {
          label: "Migration and replication telemetry",
          detail: "Bytes, duration, retries, failures, checkpoints, and replica lag.",
          state: "planned",
        },
      ],
      noticeTitle: "Every decision must be explainable",
      noticeDescription: "Operators should be able to answer why a project moved, why a node was chosen, and what prevents a migration from committing.",
    },
  };
  const panel = panels[section];

  if (panel) {
    return <PlaceholderPanel {...panel} />;
  }

  return (
    <PlaceholderPanel
      icon={Waypoints}
      title="Fabric area"
      description="This Fabric route is not registered in the current navigation model."
      rows={[
        {
          label: section,
          detail: detail ? `Requested detail: ${detail}` : "No detail selected.",
          state: "planned",
        },
      ]}
      noticeTitle="Unknown Fabric route"
      noticeDescription="Use the Fabric submenu to open a route-backed control-plane area."
    />
  );
}
