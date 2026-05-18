import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
;
import {
  ServerCog,
  Sparkles,
  Upload,
} from "lucide-react";

import {
  PageHeader,
  ResourceNotice,
} from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "#/components/ui/carousel";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import {
  createDashboardPlugin,
  getRuntimeConfig,
  listDashboardPlugins,
  type RuntimePluginActivationCapabilities,
  type RuntimePluginRegistryEntry,
  updateDashboardPlugin,
} from "#/lib/runtime-api";
import { useRuntimeResource } from "#/lib/use-runtime-resource";

export const handle = {
  pageLabel: "Marketplace",
} as const;

type MarketplaceCatalogItem = {
  name: string;
  title: string;
  badge: "official" | "community";
  category: string;
  summary: string;
  description: string;
  details: string[];
  tags: readonly string[];
  maintainer: string;
  installsLabel: string;
  version?: string;
  runtimePluginName?: string;
  runtimeServiceName?: string;
  pageLabel?: string;
};

const communityCatalog: readonly MarketplaceCatalogItem[] = [
  {
    name: "community-search",
    title: "Search Kit",
    badge: "community",
    category: "Search",
    summary: "Search, filters, and indexing workflows for content-heavy projects.",
    description:
      "Placeholder listing for future community search plugins and provider-backed indexing packages.",
    details: [
      "Planned catalog entry",
      "Provider contracts still in progress",
      "Intended for content, docs, and commerce search flows",
    ],
    tags: ["search", "content", "indexing"],
    maintainer: "Open community",
    installsLabel: "Preview listing",
  },
  {
    name: "community-analytics",
    title: "Analytics Bridge",
    badge: "community",
    category: "Analytics",
    summary: "Dashboards and event adapters for product and storefront telemetry.",
    description:
      "Placeholder listing for community analytics bridges that can sit beside Zelavis core services.",
    details: [
      "Planned catalog entry",
      "Could map to warehouse, BI, or event-stream backends",
      "Install flow not finalized yet",
    ],
    tags: ["analytics", "events", "warehouse"],
    maintainer: "Open community",
    installsLabel: "Preview listing",
  },
  {
    name: "community-comments",
    title: "Discussion Layer",
    badge: "community",
    category: "Engagement",
    summary: "Forum, comments, and moderation tooling for content-driven apps.",
    description:
      "Placeholder listing for community plugins that add higher-level collaboration or engagement surfaces.",
    details: [
      "Planned catalog entry",
      "Would likely ship as a plugin with nested workspace panels",
      "Runtime contracts still exploratory",
    ],
    tags: ["comments", "moderation", "community"],
    maintainer: "Open community",
    installsLabel: "Preview listing",
  },
] as const;

function createOfficialCatalog(
  plugins: readonly RuntimePluginRegistryEntry[],
): MarketplaceCatalogItem[] {
  const pluginByName = new Map(plugins.map((plugin) => [plugin.name, plugin]));

  return [
    {
      name: "zelavis-ecommerce",
      title: "Zelavis Ecommerce",
      badge: "official",
      category: "Commerce",
      summary: "Products, orders, customers, coupons, and future storefront workflows.",
      description:
        "Official Zelavis commerce plugin. This is the best current proving ground for plugin-owned workspace areas with nested panels.",
      details: [
      "Promoted official plugin",
      "Workspace area with nested slides",
      "Install state is real; host activation applies the live plugin graph",
      ],
      tags: ["products", "orders", "customers"],
      maintainer: "Zelavis team",
      installsLabel: "Official release",
      version: pluginByName.get("zelavis-ecommerce")?.version ?? "0.1.0",
      runtimePluginName: "zelavis-ecommerce",
      runtimeServiceName: "commerce",
      pageLabel: "Commerce",
    },
    {
      name: "zelavis-payments",
      title: "Zelavis Payments",
      badge: "official",
      category: "Payments",
      summary: "Future payment orchestration, provider plugins, and settlement tooling.",
      description:
        "Placeholder for an official payments-focused plugin once the commerce and provider boundaries settle.",
      details: [
        "Official roadmap placeholder",
        "Would likely pair with commerce",
        "Install flow not available yet",
      ],
      tags: ["payments", "providers", "settlement"],
      maintainer: "Zelavis team",
      installsLabel: "Roadmap",
      version: "planned",
    },
  ];
}

function getPluginStatus(
  pluginName: string | undefined,
  plugins: readonly RuntimePluginRegistryEntry[] | undefined,
) {
  if (!pluginName || !plugins) {
    return undefined;
  }

  return plugins.find((plugin) => plugin.name === pluginName)?.status;
}

function hasPendingPluginActivation(
  item: MarketplaceCatalogItem,
  baselinePlugins: readonly RuntimePluginRegistryEntry[] | undefined,
  currentPlugins: readonly RuntimePluginRegistryEntry[] | undefined,
  activeServices: readonly string[] | undefined,
) {
  if (!item.runtimePluginName) {
    return false;
  }

  const baselineStatus = getPluginStatus(item.runtimePluginName, baselinePlugins);
  const currentStatus = getPluginStatus(item.runtimePluginName, currentPlugins);
  const installChanged =
    baselineStatus !== undefined &&
    currentStatus !== undefined &&
    baselineStatus !== currentStatus;
  const serviceMismatch = item.runtimeServiceName
    ? currentStatus === "installed"
      ? !activeServices?.includes(item.runtimeServiceName)
      : activeServices?.includes(item.runtimeServiceName)
    : false;

  return installChanged || Boolean(serviceMismatch);
}

function formatActivationStrategy(
  strategy: RuntimePluginActivationCapabilities["strategy"],
) {
  switch (strategy) {
    case "runtime-graph":
      return "Runtime graph";
    case "worker-boundary":
      return "Worker boundary";
    case "function-boundary":
      return "Function boundary";
    case "custom":
      return "Custom host";
  }
}

function formatCapability(value: boolean) {
  return value ? "Supported" : "Not available";
}

function getWorkerBoundaryMessage(
  capabilities: RuntimePluginActivationCapabilities | undefined,
) {
  if (!capabilities || capabilities.strategy !== "worker-boundary") {
    return undefined;
  }

  if (
    capabilities.supportsRuntimeInstall &&
    capabilities.supportsUploadedSpecifiers &&
    capabilities.supportsIsolatedExecution
  ) {
    return "Worker dispatch is configured for this host. Plugin installs can be activated through an isolated worker boundary.";
  }

  return "This host reports a worker-boundary strategy, but dispatch activation is incomplete. Marketplace can update metadata, but runtime plugin uploads may stay pending until the adapter supplies dispatch, uploaded source, and isolation support.";
}

function MarketplacePluginCard({
  item,
  status,
  pending,
  onInstallToggle,
  onInfo,
}: {
  item: MarketplaceCatalogItem;
  status?: "installed" | "available";
  pending?: boolean;
  onInstallToggle?: () => void;
  onInfo: () => void;
}) {
  const isInstalled = status === "installed";

  return (
    <Card className="flex h-full min-h-[18rem] flex-col border-border/80">
      <CardHeader className="gap-4">
        <div className="flex items-start gap-3 border-b pb-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Sparkles className="size-4" />
          </span>
          <div className="space-y-1">
            <CardTitle className="text-xl">{item.title}</CardTitle>
            <CardDescription className="text-sm leading-6">
              {item.summary}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="text-sm leading-6 text-muted-foreground">
          {item.description}
        </p>
      </CardContent>
      <CardFooter className="mt-auto flex min-h-14 items-center gap-2">
        {item.runtimePluginName ? (
          <Button
            size="sm"
            variant={isInstalled ? "outline" : "default"}
            disabled={!onInstallToggle || pending}
            onClick={onInstallToggle}
          >
            {pending
              ? isInstalled
                ? "Removing..."
                : "Installing..."
              : isInstalled
                ? "Uninstall"
                : "Install"}
          </Button>
        ) : (
          <Button size="sm" disabled>
            Install
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={onInfo}>
          Info
        </Button>
      </CardFooter>
    </Card>
  );
}

function Marketplace() {
  const runtime = useRuntimeResource(getRuntimeConfig);
  const runtimeConfig = runtime.data;
  const pluginResource = useRuntimeResource(
    async () => (runtimeConfig ? listDashboardPlugins(runtimeConfig) : undefined),
    [runtimeConfig?.api.basePath],
  );
  const [pluginEntries, setPluginEntries] = useState<
    readonly RuntimePluginRegistryEntry[] | undefined
  >(undefined);
  const [actionError, setActionError] = useState<string>();
  const [pluginSpecifier, setPluginSpecifier] = useState("");
  const [selectedPluginFile, setSelectedPluginFile] = useState<File>();
  const [pendingPluginName, setPendingPluginName] = useState<string>();
  const [addingPlugin, setAddingPlugin] = useState(false);
  const [activationRequired, setActivationRequired] = useState(false);
  const [activationMessage, setActivationMessage] = useState<string>();
  const [selectedItem, setSelectedItem] = useState<MarketplaceCatalogItem | null>(null);

  useEffect(() => {
    if (pluginResource.data) {
      setPluginEntries(pluginResource.data);
    } else if (!runtimeConfig) {
      setPluginEntries(undefined);
    }
  }, [pluginResource.data, runtimeConfig]);

  const effectivePlugins = pluginEntries;
  const officialCatalog = useMemo(
    () => createOfficialCatalog(effectivePlugins ?? []),
    [effectivePlugins],
  );
  const uploadedPlugins = useMemo(
    () =>
      (effectivePlugins ?? []).filter(
        (plugin) => plugin.source === "community" && plugin.specifier,
      ),
    [effectivePlugins],
  );
  const activeServiceNames = runtimeConfig?.services.map((service) => service.name);
  const activationCapabilities = runtimeConfig?.pluginActivation?.capabilities;
  const canUploadPluginSource = Boolean(
    activationCapabilities?.supportsPackageUploads ||
      activationCapabilities?.supportsUploadedSpecifiers,
  );
  const canUploadPluginPackage =
    activationCapabilities?.supportsPackageUploads ?? false;
  const canRegisterPluginSpecifier =
    activationCapabilities?.supportsUploadedSpecifiers ?? false;
  const workerBoundaryMessage = getWorkerBoundaryMessage(activationCapabilities);
  const marketplaceActivationRequired =
    activationRequired ||
    officialCatalog.some((item) =>
      hasPendingPluginActivation(
        item,
        runtimeConfig?.plugins,
        effectivePlugins,
        activeServiceNames,
      ),
    );

  async function togglePlugin(pluginName: string, status: "installed" | "available") {
    if (!runtimeConfig || pendingPluginName) {
      return;
    }

    setPendingPluginName(pluginName);
    setActionError(undefined);

    try {
      const result = await updateDashboardPlugin(runtimeConfig, pluginName, {
        status,
      });

      setPluginEntries(result.plugins);
      setActivationRequired(result.activation?.status !== "active");
      setActivationMessage(result.activation?.message);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingPluginName(undefined);
    }
  }

  async function addPluginSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!runtimeConfig || addingPlugin) {
      return;
    }

    setAddingPlugin(true);
    setActionError(undefined);

    try {
      const result = await createDashboardPlugin(runtimeConfig, {
        ...(selectedPluginFile
          ? { file: selectedPluginFile }
          : { specifier: pluginSpecifier.trim() }),
        status: "available",
        source: "community",
      });

      setPluginEntries(result.plugins);
      setPluginSpecifier("");
      setSelectedPluginFile(undefined);
      setActivationRequired(result.activation?.status !== "active");
      setActivationMessage(result.activation?.message);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingPlugin(false);
    }
  }

  function selectPluginFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];

    setSelectedPluginFile(file);
    if (file) {
      setPluginSpecifier("");
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-8">
      <PageHeader
        eyebrow="Community"
        title="Marketplace"
        description="Official Zelavis plugins live up top, community plugins below, and plugin install state stays separate from runtime activation."
      />

      {marketplaceActivationRequired ? (
        <ResourceNotice
          title="Host activation required"
          description={
            activationMessage ??
            "Plugin install state has changed. Marketplace metadata updates now; mounted services activate when the current host applies its live plugin activation flow."
          }
        />
      ) : (
        <ResourceNotice
          title="Install flow model"
          description={
            activationMessage ??
            "The marketplace edits real plugin registry state. Hosts decide how activation happens: recompose the local runtime, create a worker/function, or attach another live function boundary."
          }
        />
      )}

      {activationCapabilities ? (
        <Card className="border-border/80">
          <CardHeader>
            <CardTitle>Plugin activation</CardTitle>
            <CardDescription>
              {activationCapabilities.description ??
                "The current host declares how it can apply plugin registry changes."}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm sm:grid-cols-2 xl:grid-cols-5">
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Strategy
              </p>
              <p className="mt-1 font-medium text-foreground">
                {formatActivationStrategy(activationCapabilities.strategy)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Runtime install
              </p>
              <p className="mt-1 font-medium text-foreground">
                {formatCapability(activationCapabilities.supportsRuntimeInstall)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Uploaded sources
              </p>
              <p className="mt-1 font-medium text-foreground">
                {formatCapability(activationCapabilities.supportsUploadedSpecifiers)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                ZIP packages
              </p>
              <p className="mt-1 font-medium text-foreground">
                {formatCapability(activationCapabilities.supportsPackageUploads)}
              </p>
            </div>
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Isolation
              </p>
              <p className="mt-1 font-medium text-foreground">
                {formatCapability(activationCapabilities.supportsIsolatedExecution)}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {workerBoundaryMessage ? (
        <ResourceNotice
          title={
            activationCapabilities?.supportsRuntimeInstall &&
            activationCapabilities.supportsUploadedSpecifiers &&
            activationCapabilities.supportsIsolatedExecution
              ? "Worker dispatch configured"
              : "Worker dispatch incomplete"
          }
          description={workerBoundaryMessage}
        />
      ) : null}

      {activationCapabilities?.strategy === "worker-boundary" ? (
        <Card className="border-border/80">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ServerCog className="size-4" />
              Worker dispatch
            </CardTitle>
            <CardDescription>
              Plugins activate outside the main runtime through an isolated worker endpoint.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm md:grid-cols-3">
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Endpoint
              </p>
              <p className="mt-1 font-mono text-xs text-foreground">
                /__zelavis/plugin/activate
              </p>
            </div>
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Registry changes
              </p>
              <p className="mt-1 font-medium text-foreground">
                Sent to plugin Worker
              </p>
            </div>
            <div className="rounded-md border bg-muted/35 px-3 py-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Main runtime
              </p>
              <p className="mt-1 font-medium text-foreground">
                No restart required
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {actionError ? (
        <ResourceNotice
          title="Plugin update failed"
          description={actionError}
        />
      ) : null}

      <Card className="border-border/80">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4" />
            Upload plugin
          </CardTitle>
          <CardDescription>
            Upload a ZIP plugin package or register an ESM source that the current host can activate through its live plugin flow.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="plugin-source-form"
            className="grid gap-4"
            onSubmit={addPluginSource}
          >
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="grid gap-2 text-sm font-medium text-foreground">
                Plugin package
                <Input
                  type="file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  onChange={selectPluginFile}
                  disabled={addingPlugin}
                />
              </label>
              <Button
                type="submit"
                className="self-end"
                disabled={
                  addingPlugin ||
                  !runtimeConfig ||
                  !canUploadPluginSource ||
                  (selectedPluginFile
                    ? !canUploadPluginPackage
                    : !canRegisterPluginSpecifier ||
                      pluginSpecifier.trim().length === 0)
                }
              >
                {addingPlugin ? "Adding..." : "Add plugin"}
              </Button>
            </div>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              ESM specifier
              <Input
                value={pluginSpecifier}
                onChange={(event) => {
                  setPluginSpecifier(event.target.value);
                  if (event.target.value.trim()) {
                    setSelectedPluginFile(undefined);
                  }
                }}
                placeholder="@scope/plugin, https://cdn.example/plugin.mjs, or /absolute/dist/index.js"
                disabled={addingPlugin}
              />
            </label>
          </form>
          <p className="mt-3 text-sm text-muted-foreground">
            {canUploadPluginSource
              ? selectedPluginFile
                ? canUploadPluginPackage
                  ? `${selectedPluginFile.name} will be uploaded as a plugin package. The current host will unpack it, resolve its ESM entry, and read the plugin definition from there.`
                  : "The current host does not support ZIP package uploads yet. Use the ESM specifier field instead."
                : "Choose a ZIP plugin package or enter an ESM specifier. Browsers cannot expose the selected absolute file path, so local path installs still use the specifier field."
              : "The current host does not declare uploaded ESM specifier support, so manual plugin sources are disabled here."}
          </p>
        </CardContent>
      </Card>

      <section className="grid gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="kicker">Official</p>
              <h2 className="text-xl font-semibold tracking-tight">Promoted plugins</h2>
            </div>
          </div>

          <Carousel opts={{ align: "start", loop: false }} className="w-full py-1">
            <CarouselContent className="ml-0 gap-2">
              {officialCatalog.map((item) => {
                const status = getPluginStatus(item.runtimePluginName, effectivePlugins);
                const isInstalled = status === "installed";

                return (
                  <CarouselItem
                    key={item.name}
                    className="basis-full pl-0 md:basis-1/2 xl:basis-1/3 2xl:basis-1/4"
                  >
                    <MarketplacePluginCard
                      item={item}
                      status={status}
                      pending={pendingPluginName === item.runtimePluginName}
                      onInstallToggle={
                        item.runtimePluginName
                          ? () =>
                              togglePlugin(
                                item.runtimePluginName!,
                                isInstalled ? "available" : "installed",
                              )
                          : undefined
                      }
                      onInfo={() => setSelectedItem(item)}
                    />
                  </CarouselItem>
                );
              })}
            </CarouselContent>
            <div className="mt-4 flex items-center justify-end gap-2 pe-1">
              <CarouselPrevious className="static translate-x-0 translate-y-0" />
              <CarouselNext className="static translate-x-0 translate-y-0" />
            </div>
          </Carousel>
        </div>
      </section>

      <section className="grid gap-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="kicker">Community</p>
            <h2 className="text-xl font-semibold tracking-tight">Plugin catalog</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Placeholder community cards for the broader grid-based catalog experience.
            </p>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {communityCatalog.map((item) => (
            <MarketplacePluginCard
              key={item.name}
              item={item}
              onInfo={() => setSelectedItem(item)}
            />
          ))}
        </div>
      </section>

      {uploadedPlugins.length > 0 ? (
        <section className="grid gap-4">
          <div>
            <p className="kicker">Local registry</p>
            <h2 className="text-xl font-semibold tracking-tight">Uploaded sources</h2>
          </div>
          <div className="grid gap-2 rounded-md border">
            {uploadedPlugins.map((plugin) => (
              <div
                key={plugin.name}
                className="grid gap-2 border-b p-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{plugin.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {plugin.specifier}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pendingPluginName === plugin.name}
                  onClick={() =>
                    togglePlugin(
                      plugin.name,
                      plugin.status === "installed" ? "available" : "installed",
                    )
                  }
                >
                  {plugin.status === "installed" ? "Disable" : "Install"}
                </Button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <Sheet open={Boolean(selectedItem)} onOpenChange={(open) => !open && setSelectedItem(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          {selectedItem ? (
            <>
              <SheetHeader>
                <SheetTitle>{selectedItem.title}</SheetTitle>
                <SheetDescription>{selectedItem.summary}</SheetDescription>
              </SheetHeader>
              <div className="grid gap-4 px-4 pb-6 text-sm text-muted-foreground">
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-md border bg-muted/35 px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                      Category
                    </p>
                    <p className="mt-1 font-medium text-foreground">{selectedItem.category}</p>
                  </div>
                  <div className="rounded-md border bg-muted/35 px-3 py-3">
                    <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                      Maintainer
                    </p>
                    <p className="mt-1 font-medium text-foreground">{selectedItem.maintainer}</p>
                  </div>
                </div>
                <p className="leading-6">{selectedItem.description}</p>
                <div className="flex flex-wrap gap-2">
                  {selectedItem.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-md border bg-muted/35 px-2.5 py-1 text-xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
                <div className="grid gap-2">
                  {selectedItem.details.map((detail) => (
                    <div
                      key={detail}
                      className="rounded-md border bg-muted/35 px-3 py-2"
                    >
                      {detail}
                    </div>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </section>
  );
}

export default Marketplace;
