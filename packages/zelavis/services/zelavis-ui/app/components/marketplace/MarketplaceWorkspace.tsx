import {
  Boxes,
  Check,
  Info,
  Layers,
  LoaderCircle,
  Palette,
  RefreshCw,
  ShieldCheck,
  Plug,
  Plus,
  Search,
} from "lucide-react";
import * as React from "react";
import { Link, useNavigate, useRevalidator, useRouteLoaderData } from "react-router";

import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import {
  MARKETPLACE_TABS,
  MARKETPLACE_TAB_LABELS,
  marketplaceTabCounts,
  marketplaceTabDisabledReason,
  marketplaceTitle,
  selectMarketplaceItems,
  type MarketplaceScope,
  type MarketplaceTab,
} from "#/lib/marketplace";
import {
  createDashboardService,
  createProject,
  refreshMarketplaceAllowlist,
  updateDashboardService,
  type MarketplaceAllowlistStatus,
  type RuntimeConfig,
  type RuntimeServiceRegistryEntry,
} from "#/lib/runtime-api";
import { toProjectPath } from "#/lib/routing";
import {
  parseAsString,
  parseAsStringLiteral,
  useTypedSearchParams,
} from "#/lib/use-typed-search-params";
import { cn } from "#/lib/utils";
import type { clientLoader as rootClientLoader } from "../../root";

const searchSchema = {
  tab: parseAsStringLiteral(MARKETPLACE_TABS),
  q: parseAsString.withDefault(""),
  details: parseAsString,
} as const;

const TAB_ICON = { apps: Boxes, frontends: Palette, plugins: Plug } as const;

const TAB_INTRO: Record<MarketplaceTab, string> = {
  apps: "Ready-made apps. Create a new Project from one with a single click.",
  frontends: "The face of a Project. Swapping it leaves the Project's data untouched.",
  plugins: "Extend Zelavis with capabilities, providers and integrations.",
};

const TAB_EMPTY: Record<MarketplaceTab, string> = {
  apps: "No apps are available yet.",
  frontends: "No frontends are available yet.",
  plugins: "No plugins are available yet.",
};

/** A stable tile colour from the name, so an entry keeps its look without shipping artwork. */
function tileStyle(name: string): React.CSSProperties {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360;
  return {
    backgroundColor: `oklch(0.94 0.05 ${hash})`,
    color: `oklch(0.42 0.13 ${hash})`,
  };
}

function Tile({ service, large = false }: { service: RuntimeServiceRegistryEntry; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={tileStyle(service.name)}
      className={cn(
        "grid shrink-0 place-items-center rounded-2xl font-semibold",
        large ? "size-16 text-2xl" : "size-12 text-lg",
      )}
    >
      {marketplaceTitle(service).charAt(0).toUpperCase()}
    </span>
  );
}

function maintainer(service: RuntimeServiceRegistryEntry) {
  if (!service.maintainer) return "Community";
  return service.maintainer === "zelavis" ? "Zelavis" : service.maintainer;
}

function actionLabel(tab: MarketplaceTab, service: RuntimeServiceRegistryEntry) {
  if (tab === "apps") return "Create project";
  return service.status === "installed" ? "Installed" : "Install";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function installService(runtime: RuntimeConfig, service: RuntimeServiceRegistryEntry) {
  if (service.installVia === "acquire") {
    await createDashboardService(runtime, {
      specifier: `npm:${service.name}@${service.version}`,
    });
  } else {
    await updateDashboardService(runtime, service.name, { status: "installed" });
  }
}

const ORIGIN_LABEL = {
  remote: "fetched just now",
  cache: "fetched from a source",
  bundled: "shipped with this release",
} as const;

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/**
 * How current the list of what may be installed is. Everything on this page is
 * installed only if that list vouches for it, so its age is worth showing.
 */
function AllowlistStatus({
  allowlist,
  onRefresh,
  refreshing,
}: {
  allowlist: MarketplaceAllowlistStatus;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const list = allowlist.list;
  const tone =
    list?.status === "fresh"
      ? "text-emerald-700 dark:text-emerald-300"
      : list?.status === "stale"
        ? "text-amber-700 dark:text-amber-300"
        : "text-destructive";
  return (
    <div
      aria-label="Allow-list"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
        <ShieldCheck className="size-4" />
        {allowlist.gated ? "Installs are limited to the allow-list" : "Allow-list gate is off"}
      </span>
      {list ? (
        <>
          <span>List {list.sequence}</span>
          <span className={tone}>{list.status}</span>
          <span>{ORIGIN_LABEL[list.origin]}</span>
          <span>issued {formatDate(list.issuedAt)}</span>
          <span>expires {formatDate(list.expiresAt)}</span>
        </>
      ) : (
        <span>No list is held</span>
      )}
      {allowlist.sources > 0 ? (
        <Button
          type="button"
          variant="ghost"
          className="ml-auto"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          Refresh
        </Button>
      ) : (
        <span className="ml-auto">No sources configured</span>
      )}
    </div>
  );
}

export function MarketplaceWorkspace({
  scope,
  allowlist,
}: {
  scope: MarketplaceScope;
  allowlist?: MarketplaceAllowlistStatus;
}) {
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  const revalidator = useRevalidator();
  const navigate = useNavigate();
  const [{ tab: requestedTab, q, details }, setParams] = useTypedSearchParams(searchSchema);
  const [busy, setBusy] = React.useState<string>();
  const [message, setMessage] = React.useState<{ text: string; tone: "ok" | "error" }>();
  const [creating, setCreating] = React.useState<RuntimeServiceRegistryEntry>();
  const [projectName, setProjectName] = React.useState("");
  const [refreshing, setRefreshing] = React.useState(false);

  const runtime = rootData?.runtime;
  const controlRuntime = rootData?.controlRuntime;
  // Apps always come from, and create Projects on, the Platform. Frontends and
  // plugins are installed into the scope being looked at: the Platform itself,
  // or the one Project whose Marketplace this is.
  const registry = runtime?.serviceRegistry ?? [];
  const appRegistry = controlRuntime?.serviceRegistry ?? registry;
  const registryFor = (entry: MarketplaceTab) => (entry === "apps" ? appRegistry : registry);

  const tab: MarketplaceTab =
    requestedTab && !marketplaceTabDisabledReason(requestedTab, scope) ? requestedTab : "apps";
  const items = selectMarketplaceItems(registryFor(tab), tab, q);
  const selected = details
    ? registryFor(tab).find((service) => service.name === details)
    : undefined;

  React.useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(undefined), 6000);
    return () => window.clearTimeout(timeout);
  }, [message]);

  if (!runtime || !controlRuntime) return null;

  const allCounts = {
    apps: marketplaceTabCounts(appRegistry).apps,
    frontends: marketplaceTabCounts(registry).frontends,
    plugins: marketplaceTabCounts(registry).plugins,
  };

  async function install(service: RuntimeServiceRegistryEntry) {
    setBusy(service.name);
    setMessage(undefined);
    try {
      await installService(runtime!, service);
      setMessage({ text: `Installed ${marketplaceTitle(service)}.`, tone: "ok" });
      revalidator.revalidate();
    } catch (error) {
      setMessage({ text: errorMessage(error), tone: "error" });
    } finally {
      setBusy(undefined);
    }
  }

  async function createFrom(service: RuntimeServiceRegistryEntry, name: string) {
    setBusy(service.name);
    setMessage(undefined);
    try {
      // A recipe that is not installed yet is installed first, so the one click
      // is the whole job.
      if (service.status === "available") await installService(controlRuntime!, service);
      const project = await createProject(controlRuntime!, {
        name,
        recipeName: service.name,
        start: true,
      });
      setCreating(undefined);
      setProjectName("");
      revalidator.revalidate();
      navigate(toProjectPath("/", project.id));
    } catch (error) {
      setMessage({ text: errorMessage(error), tone: "error" });
    } finally {
      setBusy(undefined);
    }
  }

  async function refreshList() {
    setRefreshing(true);
    setMessage(undefined);
    try {
      const report = await refreshMarketplaceAllowlist(controlRuntime!);
      const failed = report.attempts.filter((attempt) => attempt.outcome !== "ok");
      setMessage(
        report.updated
          ? { text: `Allow-list updated to list ${report.list?.sequence}.`, tone: "ok" }
          : failed.length === report.attempts.length && failed.length > 0
            ? { text: `Could not reach a source: ${failed[0]?.detail ?? failed[0]?.outcome}`, tone: "error" }
            : { text: "The allow-list is already the newest.", tone: "ok" },
      );
      revalidator.revalidate();
    } catch (error) {
      setMessage({ text: errorMessage(error), tone: "error" });
    } finally {
      setRefreshing(false);
    }
  }

  function act(service: RuntimeServiceRegistryEntry) {
    if (tab === "apps") {
      setCreating(service);
      setProjectName(`My ${marketplaceTitle(service)}`);
    } else {
      void install(service);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6" aria-label="Marketplace">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div role="tablist" aria-label="Marketplace sections" className="flex flex-wrap gap-1 border-b sm:border-b-0">
          {MARKETPLACE_TABS.map((entry) => {
            const Icon = TAB_ICON[entry];
            const reason = marketplaceTabDisabledReason(entry, scope);
            const active = entry === tab;
            const content = (
              <>
                <Icon className="size-4" />
                {MARKETPLACE_TAB_LABELS[entry]}
                <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground">
                  {allCounts[entry]}
                </span>
              </>
            );
            const base =
              "inline-flex items-center gap-2 rounded-t-xl border-b-2 px-3 py-2 text-sm font-medium transition-colors";
            return reason ? (
              <span
                key={entry}
                role="tab"
                aria-selected={false}
                aria-disabled="true"
                title={reason}
                className={cn(base, "cursor-not-allowed border-transparent text-muted-foreground/50")}
              >
                {content}
              </span>
            ) : (
              <Link
                key={entry}
                role="tab"
                aria-selected={active}
                to={{ search: entry === "apps" ? "" : `?tab=${entry}` }}
                className={cn(
                  base,
                  active
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {content}
              </Link>
            );
          })}
        </div>

        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Search the marketplace</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={q}
            onChange={(event) => setParams({ q: event.target.value || null })}
            placeholder={`Search ${MARKETPLACE_TAB_LABELS[tab].toLowerCase()}…`}
            className="pl-9"
          />
        </label>
      </div>

      <p className="text-sm text-muted-foreground">{TAB_INTRO[tab]}</p>

      {allowlist ? (
        <AllowlistStatus allowlist={allowlist} onRefresh={() => void refreshList()} refreshing={refreshing} />
      ) : null}

      {message ? (
        <p
          role="status"
          className={cn(
            "rounded-xl border px-3 py-2 text-sm",
            message.tone === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
          )}
        >
          {message.text}
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="grid place-items-center gap-2 rounded-2xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          <Layers className="size-6" />
          {q ? "Nothing matches that search." : TAB_EMPTY[tab]}
        </div>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label={MARKETPLACE_TAB_LABELS[tab]}>
          {items.map((service) => {
            const installed = service.status === "installed";
            const pending = busy === service.name;
            return (
              <li
                key={service.name}
                className="flex flex-col gap-4 rounded-2xl border bg-card p-5 text-card-foreground"
              >
                <div className="flex items-start gap-4">
                  <Tile service={service} />
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{marketplaceTitle(service)}</h3>
                    <p className="truncate text-xs text-muted-foreground">
                      By {maintainer(service)}
                      {service.version ? ` · v${service.version}` : ""}
                    </p>
                  </div>
                </div>
                <p className="line-clamp-3 flex-1 text-sm text-muted-foreground">
                  {service.marketplace?.summary ?? "No description provided."}
                </p>
                <div className="flex items-center justify-end gap-2 border-t pt-4">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setParams({ details: service.name })}
                    >
                      <Info />
                      More details
                    </Button>
                    {tab !== "apps" && installed ? (
                      <Badge variant="outline" className="gap-1">
                        <Check className="size-3" />
                        Installed
                      </Badge>
                    ) : (
                      <Button type="button" disabled={pending} onClick={() => act(service)}>
                        {pending ? <LoaderCircle className="animate-spin" /> : tab === "apps" ? <Plus /> : null}
                        {actionLabel(tab, service)}
                      </Button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Sheet open={Boolean(selected)} onOpenChange={(open) => !open && setParams({ details: null })}>
        <SheetContent>
          {selected ? (
            <>
              <SheetHeader>
                <div className="flex items-center gap-4">
                  <Tile service={selected} large />
                  <div>
                    <SheetTitle>{marketplaceTitle(selected)}</SheetTitle>
                    <SheetDescription>By {maintainer(selected)}</SheetDescription>
                  </div>
                </div>
              </SheetHeader>
              <div className="grid gap-4 overflow-auto p-4 text-sm">
                <p>{selected.marketplace?.description ?? selected.marketplace?.summary ?? "No description provided."}</p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
                  <dt className="text-muted-foreground">Package</dt>
                  <dd className="break-all">{selected.name}</dd>
                  {selected.version ? (
                    <>
                      <dt className="text-muted-foreground">Version</dt>
                      <dd>{selected.version}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Status</dt>
                  <dd className="capitalize">{selected.status}</dd>
                  {selected.project?.runtimeKinds?.length ? (
                    <>
                      <dt className="text-muted-foreground">Runs on</dt>
                      <dd>{selected.project.runtimeKinds.join(", ")}</dd>
                    </>
                  ) : null}
                  {selected.marketplace?.categories?.length ? (
                    <>
                      <dt className="text-muted-foreground">Categories</dt>
                      <dd>{selected.marketplace.categories.join(", ")}</dd>
                    </>
                  ) : null}
                  {selected.marketplace?.tags?.length ? (
                    <>
                      <dt className="text-muted-foreground">Tags</dt>
                      <dd>{selected.marketplace.tags.join(", ")}</dd>
                    </>
                  ) : null}
                </dl>
                {tab === "apps" || selected.status === "available" ? (
                  <Button type="button" className="w-fit" onClick={() => act(selected)}>
                    {actionLabel(tab, selected)}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      <Dialog open={Boolean(creating)} onOpenChange={(open) => !open && setCreating(undefined)}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (creating && projectName.trim()) void createFrom(creating, projectName.trim());
            }}
          >
            <DialogHeader>
              <DialogTitle>Create a {creating ? marketplaceTitle(creating) : ""} project</DialogTitle>
              <DialogDescription>
                {creating?.status === "available"
                  ? "It is installed first, then the new Project starts in its own runtime."
                  : "The new Project starts in its own runtime."}
              </DialogDescription>
            </DialogHeader>
            <label className="grid gap-1.5 text-sm">
              Project name
              <Input
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
                autoFocus
                required
              />
            </label>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreating(undefined)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!projectName.trim() || busy !== undefined}>
                {busy ? <LoaderCircle className="animate-spin" /> : null}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}
