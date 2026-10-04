import type * as React from "react";
import {
  LayoutDashboard,
  Pause,
  Play,
  Plus,
  RotateCw,
  Search,
  SquareStack,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useRevalidator, useRouteLoaderData } from "react-router";

import { ResourceNotice, StatusBadge } from "#/components/DashboardPage";
import { AssistantButton } from "#/components/assistant/AssistantButton";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "#/components/ui/empty";
import { Input } from "#/components/ui/input";
import {
  getDashboardProjectsForAccess,
  toDashboardProjectItem,
} from "#/lib/dashboard-data";
import {
  createProject,
  deleteProject,
  restartProject,
  upgradeProject,
  setProjectRunning,
  type RuntimeProject,
} from "#/lib/runtime-api";
import { toDashboardPath, toProjectPath } from "#/lib/routing";
import { projectSiteUrl } from "#/lib/project-site-url";
import {
  parseAsString,
  useTypedSearchParams,
} from "#/lib/use-typed-search-params";
import type { clientLoader as rootClientLoader } from "../root";

export const handle = {
  pageLabel: "Projects",
} as const;

const projectSearchSchema = {
  q: parseAsString.withDefault(""),
  new: parseAsString.withDefault(""),
  name: parseAsString.withDefault(""),
  recipe: parseAsString.withDefault("zelavis/app"),
} as const;

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * A Project whose recipe this Platform has moved past (or no longer ships). It
 * lives on the card, not on the Project's own pages: those need a running
 * Project, and a Project that cannot start is the one that needs upgrading.
 */
function RecipeUpgradeNotice({
  project,
  recipes,
  disabled,
  onUpgrade,
}: {
  project: RuntimeProject;
  recipes: readonly { name: string; title: string }[];
  disabled: boolean;
  onUpgrade: (recipeName?: string) => void;
}) {
  const [target, setTarget] = useState(recipes[0]?.name ?? "");
  const status = project.recipeStatus;
  const idle = project.runtime.status === "stopped" || project.runtime.status === "failed";
  const live = project.runtime.status === "running" && project.capabilities.zeroDowntimeUpdates === true;
  const canUpgrade = idle || live;
  if (project.deletion) return null;
  if (project.runtimeUpdate) return (
    <div className="grid gap-2 rounded-md border p-3 text-sm" aria-label="Project update">
      <p>{project.runtimeUpdate.error ? "Update recovery required" : "Update in progress"}</p>
      {project.runtimeUpdate.error ? <p className="text-destructive">{project.runtimeUpdate.error}</p> : null}
      {project.runtimeUpdate.error ? <Button type="button" variant="outline" disabled={disabled} onClick={() => onUpgrade()}>Retry update</Button> : null}
    </div>
  );
  if (!status || status.state === "current") return null;
  return (
    <div className="grid gap-2 rounded-md border p-3 text-sm" aria-label="Recipe upgrade">
      <p>
        {status.state === "upgradeAvailable"
          ? `A newer recipe is available: ${status.version}. Upgrading keeps this Project's data.`
          : `${status.reason} Choose a recipe to move this Project to; its data is kept.`}
      </p>
      {status.state === "unavailable" ? (
        <select
          aria-label="Recipe to move to"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          disabled={disabled || !canUpgrade}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm"
        >
          {recipes.map((recipe) => (
            <option key={recipe.name} value={recipe.name}>
              {recipe.title}
            </option>
          ))}
        </select>
      ) : null}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={disabled || !canUpgrade || (status.state === "unavailable" && !target)}
          onClick={() => onUpgrade(status.state === "unavailable" ? target : undefined)}
        >
          Upgrade recipe
        </Button>
        {!canUpgrade ? <span className="text-xs text-muted-foreground">Stop the Project first.</span> : null}
      </div>
    </div>
  );
}

function ProjectsRoute() {
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  const revalidator = useRevalidator();
  const [{ q, new: createMode, name: requestedName, recipe: recipeName }, setParams] =
    useTypedSearchParams(projectSearchSchema);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const [pendingProjectId, setPendingProjectId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const projects = rootData?.projects ?? [];
  const projectRecipes =
    rootData?.runtime.serviceRegistry
      ?.filter((service) => service.kind === "app")
      .map((service) => ({
        name: service.name,
        title:
          service.marketplace?.title ??
          service.menu?.title ??
          service.name,
        summary: service.marketplace?.summary,
        hostPackages: service.project?.hostPackages,
        runtimeKinds: service.project?.runtimeKinds ?? ["native"],
      })) ?? [];
  const selectedRecipe =
    projectRecipes.find((recipe) => recipe.name === recipeName) ??
    projectRecipes[0];
  const showCreate = createMode === "1";
  const canCreateProjects =
    rootData?.runtime.access?.principal.permissions?.includes("*") ?? true;
  const allowedProjectIds = useMemo(
    () =>
      new Set(
        getDashboardProjectsForAccess(
          projects.map(toDashboardProjectItem),
          rootData?.runtime.access,
        ).map((project) => project.id),
      ),
    [projects, rootData?.runtime.access],
  );
  const filteredProjects = useMemo(() => {
    const query = q.trim().toLowerCase();
    return projects.filter(
      (project) =>
        allowedProjectIds.has(project.id) &&
        (!query ||
          [project.name, project.id, project.runtime.url ?? ""].some((value) =>
            value.toLowerCase().includes(query),
          )),
    );
  }, [allowedProjectIds, projects, q]);

  useEffect(() => {
    if (!message) {
      return;
    }

    const timeout = window.setTimeout(() => setMessage(undefined), 4500);
    return () => window.clearTimeout(timeout);
  }, [message]);

  async function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rootData) {
      return;
    }
    setMessage(undefined);
    setError(undefined);
    const installHostPackages = new FormData(event.currentTarget).get("installHostPackages") === "on";
    setCreating(true);

    try {
      const project = await createProject(rootData.runtime, {
        name: requestedName,
        recipeName: selectedRecipe?.name ?? recipeName,
        start: true,
        ...(installHostPackages ? { installHostPackages: true } : {}),
      });
      setParams({ name: null, new: null, recipe: null });
      setMessage(`${project.name} is running in its own project runtime.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      revalidator.revalidate();
      setCreating(false);
    }
  }

  async function changeProjectState(project: RuntimeProject, running: boolean) {
    if (!rootData) {
      return;
    }
    setMessage(undefined);
    setError(undefined);
    setPendingProjectId(project.id);
    try {
      await setProjectRunning(rootData.runtime, project.id, running);
      setMessage(`${project.name} ${running ? "started" : "stopped"}.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      revalidator.revalidate();
      setPendingProjectId(undefined);
    }
  }

  async function handleRestartProject(project: RuntimeProject) {
    if (!rootData) {
      return;
    }
    setMessage(undefined);
    setError(undefined);
    setPendingProjectId(project.id);
    try {
      await restartProject(rootData.runtime, project.id);
      setMessage(`${project.name} restarted.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      revalidator.revalidate();
      setPendingProjectId(undefined);
    }
  }

  async function handleUpgradeProject(project: RuntimeProject, targetRecipe?: string) {
    if (!rootData) {
      return;
    }
    setMessage(undefined);
    setError(undefined);
    setPendingProjectId(project.id);
    try {
      const upgraded = await upgradeProject(rootData.runtime, project.id, targetRecipe);
      setMessage(
        `${project.name} now uses ${upgraded.recipe.name}${upgraded.recipe.version ? ` ${upgraded.recipe.version}` : ""}. Its data is unchanged. ${upgraded.runtime.status === "running" ? "It is running at the same address." : "Start it when you are ready."}`,
      );
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      revalidator.revalidate();
      setPendingProjectId(undefined);
    }
  }

  async function handleDeleteProject(project: RuntimeProject) {
    if (!rootData) {
      return;
    }
    const confirmed = window.confirm(
      project.deletion
        ? `Retry deletion of ${project.name}? This permanently removes the remaining project runtime, database, files, and metadata.`
        : `Delete ${project.name}? This permanently removes the project runtime, database, files, and metadata.`,
    );
    if (!confirmed) {
      return;
    }

    setMessage(undefined);
    setError(undefined);
    setPendingProjectId(project.id);
    try {
      await deleteProject(rootData.runtime, project.id);
      setMessage(`${project.name} was deleted.`);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      revalidator.revalidate();
      setPendingProjectId(undefined);
    }
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      {showCreate && canCreateProjects ? (
        <Card>
          <CardHeader>
            <CardTitle>Create project</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.65fr)_auto]"
              onSubmit={handleCreateProject}
            >
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="project-name">
                  Name
                </label>
                <Input
                  id="project-name"
                  value={requestedName}
                  onChange={(event) =>
                    setParams({ name: event.target.value || null })
                  }
                  placeholder="My application"
                  autoFocus
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="project-recipe">
                  Project recipe
                </label>
                <div className="relative">
                  <SquareStack className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <select
                    id="project-recipe"
                    value={selectedRecipe?.name ?? recipeName}
                    onChange={(event) =>
                      setParams({ recipe: event.target.value || null })
                    }
                    className="flex h-9 w-full rounded-md border bg-background px-9 text-sm outline-hidden transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={creating || projectRecipes.length === 0}
                  >
                    {projectRecipes.map((recipe) => (
                      <option key={recipe.name} value={recipe.name}>
                        {recipe.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit" disabled={creating || projectRecipes.length === 0}>
                  {creating ? "Creating..." : "Create"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setParams({ new: null })}
                  disabled={creating}
                >
                  Cancel
                </Button>
              </div>
              {selectedRecipe?.hostPackages?.length ? (
                <label key={selectedRecipe.name} className="flex items-start gap-2 text-sm md:col-span-3">
                  <input type="checkbox" name="installHostPackages" className="mt-1" disabled={creating} />
                  <span>Install required host packages ({selectedRecipe.hostPackages.join(", ")}) if missing.
                    <span className="block text-muted-foreground">This changes the server and requires host package installation permission. Existing host services keep their configuration.</span>
                  </span>
                </label>
              ) : null}
            </form>
            {error ? (
              <div className="mt-4">
                <ResourceNotice title="Action failed" description={error} />
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {message ? (
        <ResourceNotice title="Project updated" description={message} />
      ) : null}
      {!showCreate && error ? (
        <ResourceNotice title="Action failed" description={error} />
      ) : null}

      {/* The header carries these on desktop. The row is hidden with them: left
          in place, an empty row still takes a grid gap above the first card. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between lg:hidden">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(event) => setParams({ q: event.target.value || null })}
            placeholder="Search projects"
            className="pl-9"
          />
        </div>
        {canCreateProjects ? (
          <div className="flex items-center justify-end">
            <Button
              type="button"
              onClick={() => setParams({ new: "1" })}
            >
              <Plus className="size-4" />
              New project
            </Button>
          </div>
        ) : null}
      </div>

      {filteredProjects.length > 0 ? (
        <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filteredProjects.map((project) => {
            const siteUrl = projectSiteUrl(project);
            const isRunning = project.runtime.status === "running" && !project.deletion;
            const isPending = pendingProjectId === project.id;
            return (
              <Card key={project.id} className="overflow-hidden">
                <CardHeader className="gap-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                        <SquareStack className="size-4" />
                      </span>
                      <div className="min-w-0">
                        <CardTitle className="truncate text-base">
                          {project.name}
                        </CardTitle>
                        <p className="mt-1 truncate text-sm text-muted-foreground">
                          {project.id}
                        </p>
                      </div>
                    </div>
                    <StatusBadge state={project.runtime.status} />
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 border-t pt-4">
                  <dl className="grid gap-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Recipe</dt>
                      <dd className="truncate font-medium">
                        {project.recipe.title}
                        {project.recipe.version ? ` ${project.recipe.version}` : ""}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Runtime</dt>
                      <dd className="truncate font-medium">
                        <span className="capitalize">{project.runtimeKind}</span>
                        {" · "}{project.runtime.driver}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Site</dt>
                      <dd className="truncate font-medium">
                        {siteUrl ? (
                          <a
                            href={siteUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline-offset-4 hover:underline focus-visible:underline focus-visible:outline-none"
                          >
                            {siteUrl}
                          </a>
                        ) : (
                          project.preview?.status === "unavailable" ? "Preview unavailable" : "Not published"
                        )}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <dt className="text-muted-foreground">Updated</dt>
                      <dd className="truncate font-medium">
                        {formatUpdatedAt(project.updatedAt)}
                      </dd>
                    </div>
                  </dl>
                  {project.deletion ? (
                    <div className="grid gap-2 rounded-md border p-3 text-sm" aria-label="Project deletion">
                      <p className="font-medium">{project.deletion.status === "failed" ? "Deletion failed" : "Deletion in progress"}</p>
                      <p>This Project is pending deletion. Starting and recipe upgrades are unavailable. Retry deletion to finish removing its remaining resources.</p>
                      {project.deletion.currentParticipant ? <p>Cleanup step: {project.deletion.currentParticipant}</p> : null}
                      {project.deletion.error ? <p className="text-destructive">{project.deletion.error}</p> : null}
                    </div>
                  ) : null}
                  {project.runtime.error ? (
                    <p className="text-sm text-destructive">{project.runtime.error}</p>
                  ) : null}
                  {project.preview?.error ? <p className="text-sm text-destructive">{project.preview.error}</p> : null}
                  {project.runtimeUpdate || project.recipeStatus && project.recipeStatus.state !== "current" ? (
                    <RecipeUpgradeNotice
                      project={project}
                      recipes={projectRecipes}
                      disabled={isPending}
                      onUpgrade={(target) => handleUpgradeProject(project, target)}
                    />
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    {isRunning ? (
                      <Button
                        nativeButton={false}
                        render={
                          <Link
                            to={toDashboardPath(toProjectPath("/", project.id))}
                            viewTransition
                          />
                        }
                      >
                        <LayoutDashboard className="size-4" />
                        Open
                      </Button>
                    ) : (
                      // Its pages are served by its own runtime; opening a Project
                      // that is not running has nothing to show.
                      <Button type="button" disabled title="Start the Project to open it">
                        <LayoutDashboard className="size-4" />
                        Open
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isPending || !!project.deletion || !!project.runtimeUpdate && !isRunning}
                      onClick={() => changeProjectState(project, !isRunning)}
                      aria-label={isRunning ? "Stop" : "Start"}
                    >
                      {isRunning ? <Pause className="size-4" /> : <Play className="size-4" />}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isPending || !!project.deletion || !!project.runtimeUpdate || project.runtime.status === "provisioning"}
                      onClick={() => handleRestartProject(project)}
                      aria-label="Restart"
                    >
                      <RotateCw className="size-4" />
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={isPending}
                      onClick={() => handleDeleteProject(project)}
                      aria-label={project.deletion ? "Retry deletion" : "Delete"}
                    >
                      <Trash2 className="size-4" />
                      {project.deletion ? "Retry deletion" : null}
                    </Button>
                    <AssistantButton
                      label={`Ask Assistant about ${project.name}`}
                      to={`/assistant?project=${encodeURIComponent(project.id)}`}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      ) : projects.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SquareStack />
            </EmptyMedia>
            <EmptyTitle>No projects yet</EmptyTitle>
            <EmptyDescription>
              Create a Zelavis App project to start its independent local
              runtime.
            </EmptyDescription>
          </EmptyHeader>
          {canCreateProjects ? (
            <EmptyContent>
              <Button type="button" onClick={() => setParams({ new: "1" })}>
                <Plus data-icon="inline-start" />
                Create project
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <ResourceNotice
          title="No matching projects"
          description="Try a different project search."
        />
      )}
    </section>
  );
}

export default ProjectsRoute;
