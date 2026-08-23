import {
  Activity,
  AlertTriangle,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Network,
  Server,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";

import {
  DataRow,
  ResourceNotice,
  StatCard,
  StatusBadge,
} from "#/components/DashboardPage";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "#/components/ui/chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { parseAsStringLiteral, useTypedSearchParams } from "#/lib/use-typed-search-params";

export const handle = {
  pageLabel: "Resources",
  sidebarTrail: ["Resources"],
} as const;

const resourceSearchSchema = {
  resourceView: parseAsStringLiteral(["processes", "storage", "limits"] as const),
} as const;

const pressureChartConfig = {
  cpu: {
    label: "CPU",
    color: "var(--chart-1)",
  },
  memory: {
    label: "Memory",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

const networkChartConfig = {
  inbound: {
    label: "Inbound",
    color: "var(--chart-3)",
  },
  outbound: {
    label: "Outbound",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const storageChartConfig = {
  projects: {
    label: "Projects",
    color: "var(--chart-1)",
  },
  media: {
    label: "Media",
    color: "var(--chart-2)",
  },
  databases: {
    label: "Databases",
    color: "var(--chart-3)",
  },
  backups: {
    label: "Backups",
    color: "var(--chart-4)",
  },
  logs: {
    label: "Logs",
    color: "var(--chart-5)",
  },
} satisfies ChartConfig;

const projectChartConfig = {
  cpu: {
    label: "CPU %",
    color: "var(--chart-1)",
  },
  memory: {
    label: "Memory %",
    color: "var(--chart-2)",
  },
  storage: {
    label: "Storage GB",
    color: "var(--chart-3)",
  },
} satisfies ChartConfig;

const limitsChartConfig = {
  current: {
    label: "Current",
    color: "var(--chart-2)",
  },
  warning: {
    label: "Warning",
    color: "var(--chart-3)",
  },
  critical: {
    label: "Critical",
    color: "var(--chart-4)",
  },
} satisfies ChartConfig;

const pressureSamples = [
  { time: "00:00", cpu: 18, memory: 46 },
  { time: "03:00", cpu: 22, memory: 48 },
  { time: "06:00", cpu: 31, memory: 51 },
  { time: "09:00", cpu: 47, memory: 56 },
  { time: "12:00", cpu: 39, memory: 58 },
  { time: "15:00", cpu: 52, memory: 61 },
  { time: "18:00", cpu: 44, memory: 59 },
  { time: "21:00", cpu: 28, memory: 54 },
];

const networkSamples = [
  { time: "00:00", inbound: 4.2, outbound: 1.9 },
  { time: "03:00", inbound: 3.6, outbound: 1.4 },
  { time: "06:00", inbound: 6.8, outbound: 2.8 },
  { time: "09:00", inbound: 12.4, outbound: 5.9 },
  { time: "12:00", inbound: 9.7, outbound: 4.4 },
  { time: "15:00", inbound: 14.1, outbound: 7.3 },
  { time: "18:00", inbound: 10.6, outbound: 5.2 },
  { time: "21:00", inbound: 5.1, outbound: 2.1 },
];

const storageBreakdown = [
  { key: "projects", name: "Projects", value: 18.4, fill: "var(--color-projects)" },
  { key: "media", name: "Media", value: 42.8, fill: "var(--color-media)" },
  { key: "databases", name: "Databases", value: 11.6, fill: "var(--color-databases)" },
  { key: "backups", name: "Backups", value: 24.2, fill: "var(--color-backups)" },
  { key: "logs", name: "Logs", value: 3.1, fill: "var(--color-logs)" },
];

const projectUsage = [
  { project: "Acme CMS", cpu: 34, memory: 48, storage: 22 },
  { project: "Storefront", cpu: 28, memory: 42, storage: 18 },
  { project: "Docs", cpu: 12, memory: 24, storage: 9 },
  { project: "Static hub", cpu: 7, memory: 14, storage: 4 },
];

const limitSamples = [
  { resource: "CPU", current: 52, warning: 70, critical: 90 },
  { resource: "Memory", current: 61, warning: 75, critical: 92 },
  { resource: "Disk", current: 64, warning: 80, critical: 94 },
  { resource: "Traffic", current: 43, warning: 72, critical: 90 },
];

const processRows = [
  {
    label: "zelavis-runtime",
    detail: "Main dashboard and service runtime on port 3000.",
    meta: "128 MB",
    state: "healthy",
  },
  {
    label: "site-host",
    detail: "Local website hosting worker for project domains.",
    meta: "76 MB",
    state: "healthy",
  },
  {
    label: "database-writer",
    detail: "Serialized local SQL writes and event-log append flow.",
    meta: "42 MB",
    state: "healthy",
  },
  {
    label: "backup-scheduler",
    detail: "Snapshot queue is idle; next local backup window is pending.",
    meta: "idle",
    state: "planned",
  },
] as const;

const limitRows = [
  {
    label: "Sustained CPU",
    detail: "Warn above 70% for 10 minutes, mark critical above 90%.",
    meta: "52%",
    state: "healthy",
  },
  {
    label: "Memory pressure",
    detail: "Watch used RAM, cache pressure, and swap activity together.",
    meta: "61%",
    state: "healthy",
  },
  {
    label: "Disk capacity",
    detail: "Warn before local media, database files, and backups fill the volume.",
    meta: "64%",
    state: "planned",
  },
  {
    label: "Outbound traffic",
    detail: "Track project traffic so small VPS plans do not surprise the user.",
    meta: "43%",
    state: "planned",
  },
] as const;

export default function ResourcesRoute() {
  const [{ resourceView }] = useTypedSearchParams(resourceSearchSchema);

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="CPU"
          value="52%"
          detail="8-core VPS, 24h peak 68%."
          icon={Cpu}
        />
        <StatCard
          label="Memory"
          value="61%"
          detail="4.9 GB of 8 GB in active use."
          icon={Activity}
        />
        <StatCard
          label="Disk"
          value="64%"
          detail="160 GB volume, 57 GB free."
          icon={HardDrive}
        />
        <StatCard
          label="Network"
          value="14.1 MB/s"
          detail="Peak inbound traffic today."
          icon={Network}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-4" />
              Host pressure
            </CardTitle>
            <CardDescription>CPU and memory trends across the current day.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={pressureChartConfig} className="h-72 w-full">
              <AreaChart data={pressureSamples} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={32}
                  domain={[0, 100]}
                />
                <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                <Area
                  dataKey="memory"
                  type="natural"
                  fill="var(--color-memory)"
                  fillOpacity={0.24}
                  stroke="var(--color-memory)"
                  strokeWidth={2}
                />
                <Area
                  dataKey="cpu"
                  type="natural"
                  fill="var(--color-cpu)"
                  fillOpacity={0.16}
                  stroke="var(--color-cpu)"
                  strokeWidth={2}
                />
                <ChartLegend content={<ChartLegendContent />} />
              </AreaChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HardDrive className="size-4" />
              Storage allocation
            </CardTitle>
            <CardDescription>What is consuming local disk today.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={storageChartConfig} className="mx-auto h-72 w-full">
              <PieChart>
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      nameKey="key"
                      formatter={(value, _name, item) => (
                        <div className="flex min-w-32 items-center justify-between gap-4">
                          <span className="text-muted-foreground">
                            {String(item.name)}
                          </span>
                          <span className="font-mono font-medium text-foreground">
                            {String(value)} GB
                          </span>
                        </div>
                      )}
                    />
                  }
                />
                <Pie
                  data={storageBreakdown}
                  dataKey="value"
                  nameKey="key"
                  innerRadius={58}
                  outerRadius={92}
                  paddingAngle={2}
                >
                  {storageBreakdown.map((item) => (
                    <Cell key={item.key} fill={item.fill} />
                  ))}
                </Pie>
                <ChartLegend content={<ChartLegendContent nameKey="key" />} />
              </PieChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Network className="size-4" />
              Network traffic
            </CardTitle>
            <CardDescription>Inbound and outbound throughput by sample window.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={networkChartConfig} className="h-64 w-full">
              <LineChart data={networkSamples} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="time"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={32}
                />
                <ChartTooltip
                  content={<ChartTooltipContent indicator="line" />}
                />
                <Line
                  dataKey="inbound"
                  type="monotone"
                  stroke="var(--color-inbound)"
                  strokeWidth={2}
                  dot={false}
                />
                <Line
                  dataKey="outbound"
                  type="monotone"
                  stroke="var(--color-outbound)"
                  strokeWidth={2}
                  dot={false}
                />
                <ChartLegend content={<ChartLegendContent />} />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4" />
              Project usage
            </CardTitle>
            <CardDescription>Resource pressure by hosted project.</CardDescription>
          </CardHeader>
          <CardContent>
            <ChartContainer config={projectChartConfig} className="h-64 w-full">
              <BarChart data={projectUsage} margin={{ left: 0, right: 8, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="project"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={32}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="cpu" fill="var(--color-cpu)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="memory" fill="var(--color-memory)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="storage" fill="var(--color-storage)" radius={[4, 4, 0, 0]} />
                <ChartLegend content={<ChartLegendContent />} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>
      </section>

      {resourceView === "processes" ? <ProcessesPanel /> : null}
      {resourceView === "storage" ? <StoragePanel /> : null}
      {resourceView === "limits" ? <LimitsPanel /> : null}

      <ResourceNotice
        title="Local-first telemetry"
        description="The UI is shaped for host collectors, runtime adapters, and project quotas without tying Zelavis to external billing or serverless-provider metrics."
      />
    </section>
  );
}

function ProcessesPanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="size-4" />
          Runtime processes
        </CardTitle>
        <CardDescription>Service health, memory footprint, and restart candidates.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        {processRows.map((row) => (
          <DataRow
            key={row.label}
            label={row.label}
            detail={row.detail}
            meta={
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">{row.meta}</span>
                <StatusBadge state={row.state} />
              </span>
            }
          />
        ))}
      </CardContent>
    </Card>
  );
}

function StoragePanel() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <HardDrive className="size-4" />
          Storage detail
        </CardTitle>
        <CardDescription>Local volume pressure grouped by operational class.</CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={storageChartConfig} className="h-72 w-full">
          <BarChart data={storageBreakdown} layout="vertical" margin={{ left: 4, right: 24 }}>
            <CartesianGrid horizontal={false} />
            <XAxis type="number" hide />
            <YAxis
              dataKey="name"
              type="category"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={82}
            />
            <ChartTooltip content={<ChartTooltipContent nameKey="key" />} />
            <Bar dataKey="value" radius={4}>
              {storageBreakdown.map((item) => (
                <Cell key={item.key} fill={item.fill} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function LimitsPanel() {
  return (
    <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.85fr)]">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4" />
            Guardrails
          </CardTitle>
          <CardDescription>Current usage compared with warning and critical thresholds.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer config={limitsChartConfig} className="h-72 w-full">
            <BarChart data={limitSamples} margin={{ left: 0, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="resource"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={32}
                domain={[0, 100]}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="current" fill="var(--color-current)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="warning" fill="var(--color-warning)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="critical" fill="var(--color-critical)" radius={[4, 4, 0, 0]} />
              <ChartLegend content={<ChartLegendContent />} />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Limit policy</CardTitle>
          <CardDescription>Defaults that make sense for small VPS installs.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {limitRows.map((row) => (
            <DataRow
              key={row.label}
              label={row.label}
              detail={row.detail}
              meta={
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{row.meta}</span>
                  <StatusBadge state={row.state} />
                </span>
              }
            />
          ))}
        </CardContent>
      </Card>
    </section>
  );
}
