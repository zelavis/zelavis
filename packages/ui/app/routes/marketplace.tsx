import { Link, useLoaderData, useParams, useRevalidator, useRouteLoaderData } from "react-router";
import {
  type ChangeEvent,
  type FormEvent,
  useMemo,
  useState,
} from "react";
import {
  Sparkles,
  Upload,
} from "lucide-react";

import {
  ResourceNotice,
} from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
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
  createDashboardService,
  getRuntimeConfig,
  listDashboardServices,
  type RuntimeServiceActivationCapabilities,
  type RuntimeServiceRegistryEntry,
  updateDashboardService,
} from "#/lib/runtime-api";
import { cn } from "#/lib/utils";
import type { clientLoader as rootClientLoader } from '../root';

export const handle = {
  pageLabel: "Marketplace",
} as const;

export async function clientLoader() {
  const runtime = await getRuntimeConfig();
  const serviceEntries = await listDashboardServices(runtime).catch(() => undefined);
  return { serviceEntries };
}

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
  runtimeServiceName?: string;
  pageLabel?: string;
};

type MarketplaceAppItem = {
  id: string;
  title: string;
  category: string;
  summary: string;
  description: string;
  details: readonly string[];
  tags: readonly string[];
  projectType: string;
  actionLabel: string;
};

const globalAppCatalog: readonly MarketplaceAppItem[] = [
  {
    id: "zelavis-app",
    title: "Zelavis App",
    category: "Native",
    summary: "A full Zelavis-native app with auth, database, content, media, and website hosting.",
    description:
      "Creates a project that uses Zelavis as the application platform instead of only as a host control panel.",
    details: [
      "Project dashboard uses Zelavis-native sections",
      "Best fit for apps that want integrated auth, database, and content",
      "Starter creation is wired through the project creation flow",
    ],
    tags: ["zelavis", "app", "starter"],
    projectType: "zelavis",
    actionLabel: "Create Zelavis project",
  },
  {
    id: "wordpress",
    title: "WordPress",
    category: "One-click app",
    summary: "A managed WordPress project with hosting-style controls instead of Zelavis-native app sections.",
    description:
      "Models the Softaculous-style path: Zelavis can operate the project even when the app itself is not built on Zelavis primitives.",
    details: [
      "Project dashboard should expose hosting controls",
      "WordPress admin stays the application admin",
      "Future installer can provision files, database, domains, and backups",
    ],
    tags: ["wordpress", "cms", "hosting"],
    projectType: "wordpress",
    actionLabel: "Create WordPress project",
  },
  {
    id: "static-site",
    title: "Static Website",
    category: "Website",
    summary: "A simple static-site project with domains, files, deploys, and logs.",
    description:
      "Useful for templates, portfolios, docs, and landing pages that do not need Zelavis auth or database services.",
    details: [
      "Project dashboard focuses on website operations",
      "Can later connect to local or plugin-backed deployment targets",
      "Keeps static sites separate from full Zelavis apps",
    ],
    tags: ["static", "website", "template"],
    projectType: "static",
    actionLabel: "Create static project",
  },
] as const;

const globalIntegrationCatalog: readonly MarketplaceAppItem[] = [
  {
    id: "dns-provider",
    title: "DNS Provider",
    category: "Server integration",
    summary: "Connect DNS automation for server-level domain management.",
    description:
      "Provider integrations belong globally because many projects can share the same DNS account and verification workflow.",
    details: ["Server-level plugin boundary", "Future domain automation", "Not tied to one project"],
    tags: ["dns", "domains", "server"],
    projectType: "server",
    actionLabel: "Planned",
  },
  {
    id: "backup-storage",
    title: "Backup Storage",
    category: "Server integration",
    summary: "Connect an object store or remote backup destination.",
    description:
      "Backups are a host responsibility first; projects can opt into policies once the provider is configured globally.",
    details: ["Server-level plugin boundary", "Future restore workflows", "Policy-driven backups"],
    tags: ["backups", "storage", "restore"],
    projectType: "server",
    actionLabel: "Planned",
  },
] as const;

const communityCatalog: readonly MarketplaceCatalogItem[] = [
  {
    name: "@community/search-kit",
    title: "Search Kit",
    badge: "community",
    category: "Search",
    summary: "Search, filters, and indexing workflows for content-heavy projects.",
    description:
      "Placeholder listing for future community search service packages and provider-backed indexing packages.",
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
    name: "@community/analytics-bridge",
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
    name: "@community/discussion-layer",
    title: "Discussion Layer",
    badge: "community",
    category: "Engagement",
    summary: "Forum, comments, and moderation tooling for content-driven apps.",
    description:
      "Placeholder listing for community services that add higher-level collaboration or engagement surfaces.",
    details: [
      "Planned catalog entry",
      "Would likely ship as a service with nested Extensions panels",
      "Runtime contracts still exploratory",
    ],
    tags: ["comments", "moderation", "community"],
    maintainer: "Open community",
    installsLabel: "Preview listing",
  },
] as const;

function createOfficialCatalog(
  serviceRegistry: readonly RuntimeServiceRegistryEntry[],
): MarketplaceCatalogItem[] {
  const serviceByName = new Map(serviceRegistry.map((service) => [service.name, service]));

  return [
    {
      name: "@zelavis/ecommerce",
      title: "Zelavis Ecommerce",
      badge: "official",
      category: "Commerce",
      summary: "Products, orders, customers, coupons, and future storefront workflows.",
      description:
        "Official Zelavis commerce service. This is the best current proving ground for service-owned Extensions areas with nested panels.",
      details: [
      "Promoted official service",
      "Extensions area with nested slides",
      "Install state is real; host activation applies the live service graph",
      ],
      tags: ["products", "orders", "customers"],
      maintainer: "Zelavis team",
      installsLabel: "Official release",
      version: serviceByName.get("@zelavis/ecommerce")?.version ?? "0.1.0",
      runtimeServiceName: "@zelavis/ecommerce",
      pageLabel: "Commerce",
    },
    {
      name: "@zelavis/payments",
      title: "Zelavis Payments",
      badge: "official",
      category: "Payments",
      summary: "Future payment orchestration, provider services, and settlement tooling.",
      description:
        "Placeholder for an official payments-focused service once the commerce and provider boundaries settle.",
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

function getServiceStatus(
  serviceName: string | undefined,
  serviceRegistry: readonly RuntimeServiceRegistryEntry[] | undefined,
) {
  if (!serviceName || !serviceRegistry) {
    return undefined;
  }

  return serviceRegistry.find((service) => service.name === serviceName)?.status;
}

function hasPendingServiceActivation(
  item: MarketplaceCatalogItem,
  baselineServices: readonly RuntimeServiceRegistryEntry[] | undefined,
  currentServices: readonly RuntimeServiceRegistryEntry[] | undefined,
  activeServices: readonly string[] | undefined,
) {
  if (!item.runtimeServiceName) {
    return false;
  }

  const baselineStatus = getServiceStatus(item.runtimeServiceName, baselineServices);
  const currentStatus = getServiceStatus(item.runtimeServiceName, currentServices);
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
  strategy: RuntimeServiceActivationCapabilities["strategy"],
) {
  switch (strategy) {
    case "runtime-graph":
      return "Runtime graph";
    case "external":
      return "External controller";
  }
}

function formatCapability(value: boolean) {
  return value ? "Supported" : "Not available";
}

function MarketplaceServiceCard({
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
        {item.runtimeServiceName ? (
          <Button
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
          <Button disabled>
            Install
          </Button>
        )}
        <Button variant="outline" onClick={onInfo}>
          Info
        </Button>
      </CardFooter>
    </Card>
  );
}

function GlobalAppCard({ item }: { item: MarketplaceAppItem }) {
  const canCreateProject = item.projectType !== "server";

  return (
    <Card className="flex h-full min-h-[18rem] flex-col border-border/80">
      <CardHeader className="gap-4">
        <div className="flex items-start gap-3 border-b pb-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
            <Sparkles className="size-4" />
          </span>
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {item.category}
            </p>
            <CardTitle className="text-xl">{item.title}</CardTitle>
            <CardDescription className="text-sm leading-6">
              {item.summary}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        <p className="text-sm leading-6 text-muted-foreground">
          {item.description}
        </p>
        <div className="flex flex-wrap gap-2">
          {item.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md border bg-muted/35 px-2.5 py-1 text-xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      </CardContent>
      <CardFooter className="mt-auto flex min-h-14 items-center gap-2">
        {canCreateProject ? (
          <Link
            to={`/projects?new=1&type=${encodeURIComponent(item.projectType)}`}
            className={cn(buttonVariants())}
          >
            {item.actionLabel}
          </Link>
        ) : (
          <Button disabled>
            {item.actionLabel}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function GlobalPluginCard({ item }: { item: MarketplaceCatalogItem }) {
  return (
    <Card className="flex h-full min-h-[16rem] flex-col border-border/80 opacity-75">
      <CardHeader>
        <CardTitle className="text-lg">{item.title}</CardTitle>
        <CardDescription className="leading-6">{item.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex-1">
        <p className="text-sm leading-6 text-muted-foreground">
          {item.description}
        </p>
      </CardContent>
      <CardFooter className="mt-auto flex items-center gap-2">
        <Button disabled>
          Project-only
        </Button>
        <span className="text-xs text-muted-foreground">
          Open inside a Zelavis project
        </span>
      </CardFooter>
    </Card>
  );
}

function GlobalMarketplace() {
  const { serviceEntries } = useLoaderData<typeof clientLoader>();
  const officialCatalog = useMemo(
    () => createOfficialCatalog(serviceEntries ?? []),
    [serviceEntries],
  );

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-8">
      <ResourceNotice
        title="Global marketplace scope"
        description="Apps here create or affect projects. Plugins extend an existing Zelavis project, so they are disabled in the global marketplace and active in the project marketplace."
      />

      <section className="grid gap-4">
        <div>
          <p className="kicker">Apps</p>
          <h2 className="text-xl font-semibold tracking-tight">Create projects from apps and starters</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {globalAppCatalog.map((item) => (
            <GlobalAppCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <section className="grid gap-4">
        <div>
          <p className="kicker">Server</p>
          <h2 className="text-xl font-semibold tracking-tight">Server integrations</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {globalIntegrationCatalog.map((item) => (
            <GlobalAppCard key={item.id} item={item} />
          ))}
        </div>
      </section>

      <section className="grid gap-4">
        <div>
          <p className="kicker">Project plugins</p>
          <h2 className="text-xl font-semibold tracking-tight">Install inside Zelavis projects</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            These extend a Zelavis-native project and stay unavailable from the global layer.
          </p>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[...officialCatalog, ...communityCatalog].map((item) => (
            <GlobalPluginCard key={item.name} item={item} />
          ))}
        </div>
      </section>
    </section>
  );
}

function ProjectMarketplace() {
  const { serviceEntries: initialServiceEntries } = useLoaderData<typeof clientLoader>();
  const { runtime: runtimeConfig } = useRouteLoaderData<typeof rootClientLoader>('root')!;
  const revalidator = useRevalidator();
  const [serviceEntries, setServiceEntries] = useState<
    readonly RuntimeServiceRegistryEntry[] | undefined
  >(initialServiceEntries);
  const [actionError, setActionError] = useState<string>();
  const [serviceSpecifier, setServiceSpecifier] = useState("");
  const [selectedServiceFile, setSelectedServiceFile] = useState<File>();
  const [pendingServiceName, setPendingServiceName] = useState<string>();
  const [addingService, setAddingService] = useState(false);
  const [activationRequired, setActivationRequired] = useState(false);
  const [activationMessage, setActivationMessage] = useState<string>();
  const [selectedItem, setSelectedItem] = useState<MarketplaceCatalogItem | null>(null);

  const effectiveServices = serviceEntries;
  const officialCatalog = useMemo(
    () => createOfficialCatalog(effectiveServices ?? []),
    [effectiveServices],
  );
  const uploadedServices = useMemo(
    () =>
      (effectiveServices ?? []).filter(
        (service) => service.source === "community" && service.specifier,
      ),
    [effectiveServices],
  );
  const activeServiceNames = runtimeConfig?.services.map((service) => service.name);
  const activationCapabilities = runtimeConfig?.serviceActivation?.capabilities;
  const canUploadServiceSource = Boolean(
    activationCapabilities?.supportsPackageUploads ||
      activationCapabilities?.supportsUploadedSpecifiers,
  );
  const canUploadServicePackage =
    activationCapabilities?.supportsPackageUploads ?? false;
  const canRegisterServiceSpecifier =
    activationCapabilities?.supportsUploadedSpecifiers ?? false;
  const marketplaceActivationRequired =
    activationRequired ||
    officialCatalog.some((item) =>
      hasPendingServiceActivation(
        item,
        runtimeConfig?.serviceRegistry,
        effectiveServices,
        activeServiceNames,
      ),
    );

  async function toggleService(serviceName: string, status: "installed" | "available") {
    if (pendingServiceName) {
      return;
    }

    setPendingServiceName(serviceName);
    setActionError(undefined);

    try {
      const result = await updateDashboardService(runtimeConfig, serviceName, {
        status,
      });

      setServiceEntries(result.serviceRegistry);
      setActivationRequired(result.activation?.status !== "active");
      setActivationMessage(result.activation?.message);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingServiceName(undefined);
    }
  }

  async function addServiceSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (addingService) {
      return;
    }

    setAddingService(true);
    setActionError(undefined);

    try {
      const result = await createDashboardService(runtimeConfig, {
        ...(selectedServiceFile
          ? { file: selectedServiceFile }
          : { specifier: serviceSpecifier.trim() }),
        status: "available",
        source: "community",
      });

      setServiceEntries(result.serviceRegistry);
      setServiceSpecifier("");
      setSelectedServiceFile(undefined);
      setActivationRequired(result.activation?.status !== "active");
      setActivationMessage(result.activation?.message);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAddingService(false);
    }
  }

  function selectServiceFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];

    setSelectedServiceFile(file);
    if (file) {
      setServiceSpecifier("");
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-8">
      {marketplaceActivationRequired ? (
        <ResourceNotice
          title="Host activation required"
          description={
            activationMessage ??
            "Service install state has changed. Marketplace metadata updates now; mounted services activate when the local runtime applies its service graph."
          }
        />
      ) : (
        <ResourceNotice
          title="Install flow model"
          description={
            activationMessage ??
            "The marketplace edits real service registry state. The local runtime decides whether service changes can activate immediately or need a process restart."
          }
        />
      )}

      {activationCapabilities ? (
        <Card className="border-border/80">
          <CardHeader>
            <CardTitle>Service activation</CardTitle>
            <CardDescription>
              {activationCapabilities.description ??
                "The current host declares how it can apply service registry changes."}
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

      {actionError ? (
        <ResourceNotice
          title="Service update failed"
          description={actionError}
        />
      ) : null}

      <Card className="border-border/80">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="size-4" />
            Upload service
          </CardTitle>
          <CardDescription>
            Upload a ZIP service package or register an ESM source that the local runtime can activate through its service graph.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="service-source-form"
            className="grid gap-4"
            onSubmit={addServiceSource}
          >
            <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="grid gap-2 text-sm font-medium text-foreground">
                Service package
                <Input
                  type="file"
                  accept=".zip,application/zip,application/x-zip-compressed"
                  onChange={selectServiceFile}
                  disabled={addingService}
                />
              </label>
              <Button
                type="submit"
                className="self-end"
                disabled={
                  addingService ||
                  !canUploadServiceSource ||
                  (selectedServiceFile
                    ? !canUploadServicePackage
                    : !canRegisterServiceSpecifier ||
                      serviceSpecifier.trim().length === 0)
                }
              >
                {addingService ? "Adding..." : "Add service"}
              </Button>
            </div>
            <label className="grid gap-2 text-sm font-medium text-foreground">
              ESM specifier
              <Input
                value={serviceSpecifier}
                onChange={(event) => {
                  setServiceSpecifier(event.target.value);
                  if (event.target.value.trim()) {
                    setSelectedServiceFile(undefined);
                  }
                }}
                placeholder="@scope/service, https://cdn.example/service.mjs, or /absolute/dist/index.js"
                disabled={addingService}
              />
            </label>
          </form>
          <p className="mt-3 text-sm text-muted-foreground">
            {canUploadServiceSource
              ? selectedServiceFile
                ? canUploadServicePackage
                  ? `${selectedServiceFile.name} will be uploaded as a service package. The current host will unpack it, resolve its ESM entry, and read the service definition from there.`
                  : "The current host does not support ZIP package uploads yet. Use the ESM specifier field instead."
                : "Choose a ZIP service package or enter an ESM specifier. Browsers cannot expose the selected absolute file path, so local path installs still use the specifier field."
              : "The current host does not declare uploaded ESM specifier support, so manual service sources are disabled here."}
          </p>
        </CardContent>
      </Card>

      <section className="grid gap-4">
        <div className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <p className="kicker">Official</p>
              <h2 className="text-xl font-semibold tracking-tight">Promoted services</h2>
            </div>
          </div>

          <Carousel opts={{ align: "start", loop: false }} className="w-full py-1">
            <CarouselContent className="ml-0 gap-2">
              {officialCatalog.map((item) => {
                const status = getServiceStatus(item.runtimeServiceName, effectiveServices);
                const isInstalled = status === "installed";

                return (
                  <CarouselItem
                    key={item.name}
                    className="basis-full pl-0 md:basis-1/2 xl:basis-1/3 2xl:basis-1/4"
                  >
                    <MarketplaceServiceCard
                      item={item}
                      status={status}
                      pending={pendingServiceName === item.runtimeServiceName}
                      onInstallToggle={
                        item.runtimeServiceName
                          ? () =>
                              toggleService(
                                item.runtimeServiceName!,
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
            <h2 className="text-xl font-semibold tracking-tight">Service catalog</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Placeholder community cards for the broader grid-based catalog experience.
            </p>
          </div>
        </div>

        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {communityCatalog.map((item) => (
            <MarketplaceServiceCard
              key={item.name}
              item={item}
              onInfo={() => setSelectedItem(item)}
            />
          ))}
        </div>
      </section>

      {uploadedServices.length > 0 ? (
        <section className="grid gap-4">
          <div>
            <p className="kicker">Local registry</p>
            <h2 className="text-xl font-semibold tracking-tight">Uploaded sources</h2>
          </div>
          <div className="grid gap-2 rounded-md border">
            {uploadedServices.map((service) => (
              <div
                key={service.name}
                className="grid gap-2 border-b p-4 last:border-b-0 md:grid-cols-[minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{service.name}</p>
                  <p className="truncate text-sm text-muted-foreground">
                    {service.specifier}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pendingServiceName === service.name}
                  onClick={() =>
                    toggleService(
                      service.name,
                      service.status === "installed" ? "available" : "installed",
                    )
                  }
                >
                  {service.status === "installed" ? "Disable" : "Install"}
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

function MarketplaceRoute() {
  const params = useParams();

  return params.projectId ? <ProjectMarketplace /> : <GlobalMarketplace />;
}

export default MarketplaceRoute;
