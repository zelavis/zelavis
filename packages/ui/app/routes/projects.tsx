import type * as React from "react";
import { Link, useRouteLoaderData } from "react-router";
import {
  Clock3,
  Globe2,
  LayoutDashboard,
  Plus,
  Search,
  SquareStack,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  DataRow,
  ResourceNotice,
  StatusBadge,
} from "#/components/DashboardPage";
import { Button } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  dashboardProjects,
  getDashboardProjectsForAccess,
  type DashboardProjectItem,
} from "#/lib/dashboard-data";
import type { clientLoader as rootClientLoader } from "../root";
import { toDashboardPath, toProjectPath } from "#/lib/routing";
import {
  parseAsString,
  parseAsStringLiteral,
  useTypedSearchParams,
} from "#/lib/use-typed-search-params";

export const handle = {
  pageLabel: "Projects",
} as const;

const projectSearchSchema = {
  q: parseAsString.withDefault(""),
  new: parseAsString.withDefault(""),
  name: parseAsString.withDefault(""),
  domain: parseAsString.withDefault(""),
  type: parseAsStringLiteral(["zelavis", "wordpress", "static", "generic"] as const).withDefault("zelavis"),
} as const;

const projectKindOptions = [
  {
    value: "zelavis",
    label: "Zelavis app",
    domainFallback: "localhost",
  },
  {
    value: "wordpress",
    label: "WordPress",
    domainFallback: "wordpress.localhost",
  },
  {
    value: "static",
    label: "Static website",
    domainFallback: "static.localhost",
  },
  {
    value: "generic",
    label: "Generic app",
    domainFallback: "app.localhost",
  },
] as const;

function getProjectKindLabel(kind: DashboardProjectItem["kind"]) {
  return projectKindOptions.find((option) => option.value === kind)?.label ?? "Project";
}

function slugifyProjectName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ProjectsRoute() {
  const rootData = useRouteLoaderData<typeof rootClientLoader>("root");
  const [{ q, new: createMode, name: requestedName, domain: requestedDomain, type }, setParams] =
    useTypedSearchParams(projectSearchSchema);
  const [projects, setProjects] = useState<DashboardProjectItem[]>([
    ...dashboardProjects,
  ]);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const showCreate = createMode === "1";
  const accessibleProjects = useMemo(
    () => getDashboardProjectsForAccess(projects, rootData?.runtime.access),
    [projects, rootData?.runtime.access],
  );
  const canCreateProjects =
    rootData?.runtime.access?.principal.permissions?.includes("*") ??
    true;

  useEffect(() => {
    if (requestedName) {
      setName(requestedName);
    }

    if (requestedDomain) {
      setDomain(requestedDomain);
    }
  }, [requestedDomain, requestedName]);

  const filteredProjects = useMemo(() => {
    const query = q.trim().toLowerCase();

    if (!query) {
      return accessibleProjects;
    }

    return accessibleProjects.filter((project) =>
      [project.name, project.domain].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [accessibleProjects, q]);

  function handleCreateProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(undefined);
    setError(undefined);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Project name is required.");
      return;
    }

    const id = slugifyProjectName(trimmedName);
    const projectKind = type;
    const projectId = projectKind === "zelavis" ? id : `${projectKind}-${id}`;
    if (!id) {
      setError("Project name must contain letters or numbers.");
      return;
    }

    if (projects.some((project) => project.id === projectId)) {
      setError("A project with that name already exists.");
      return;
    }

    const kindOption = projectKindOptions.find((option) => option.value === projectKind);
    const nextProject: DashboardProjectItem = {
      id: projectId,
      name: trimmedName,
      logo: projectKind === "zelavis" ? Globe2 : SquareStack,
      domain: domain.trim() || kindOption?.domainFallback || "localhost",
      kind: projectKind,
      status: "draft",
      updatedAt: "just now",
    };

    setProjects((current) => [nextProject, ...current]);
    setName("");
    setDomain("");
    setParams({ domain: null, name: null, new: null, type: null });
    setMessage(`Created ${nextProject.name}.`);
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      {showCreate && canCreateProjects ? (
        <Card>
          <CardHeader>
            <CardTitle>Create project</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form className="grid gap-4 md:grid-cols-[1fr_1fr_1fr_auto]" onSubmit={handleCreateProject}>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="project-name">
                  Name
                </label>
                <Input
                  id="project-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Marketing site"
                />
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="project-type">
                  Type
                </label>
                <select
                  id="project-type"
                  value={type}
                  onChange={(event) =>
                    setParams({
                      type: event.target.value as DashboardProjectItem["kind"],
                    })
                  }
                  className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {projectKindOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-2">
                <label className="text-sm font-medium" htmlFor="project-domain">
                  Domain
                </label>
                <Input
                  id="project-domain"
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder="example.test"
                />
              </div>
              <div className="flex items-end gap-2">
                <Button type="submit">Create</Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setParams({ new: null, type: null })}
                >
                  Cancel
                </Button>
              </div>
            </form>
            {error ? (
              <ResourceNotice title="Action failed" description={error} />
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {message ? (
        <ResourceNotice title="Project created" description={message} />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(event) => setParams({ q: event.target.value || null })}
            placeholder="Search projects"
            className="pl-9"
          />
        </div>
        <div className="flex items-center justify-between gap-3 sm:justify-end">
          <p className="text-sm text-muted-foreground">
            {filteredProjects.length} of {accessibleProjects.length} projects
          </p>
          {canCreateProjects ? (
            <Button type="button" onClick={() => setParams({ new: "1" })}>
              <Plus className="size-4" />
              New project
            </Button>
          ) : null}
        </div>
      </div>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {filteredProjects.map((project) => (
          <Card key={project.id} className="overflow-hidden">
            <CardHeader className="gap-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                    <project.logo className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">
                      {project.name}
                    </CardTitle>
                    <p className="mt-1 truncate text-sm text-muted-foreground">
                      {project.domain}
                    </p>
                  </div>
                </div>
                <StatusBadge state={project.status === "active" ? "ready" : "draft"} />
              </div>
            </CardHeader>
            <CardContent className="p-0">
              <DataRow
                label="Type"
                detail={getProjectKindLabel(project.kind)}
                meta={<SquareStack className="size-4 text-muted-foreground" />}
              />
              <DataRow
                label="Domain"
                detail={project.domain}
                meta={<Globe2 className="size-4 text-muted-foreground" />}
              />
              <DataRow
                label="Updated"
                detail={project.updatedAt}
                meta={<Clock3 className="size-4 text-muted-foreground" />}
              />
              <div className="flex items-center justify-between gap-2 px-4 py-3">
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
                <Button
                  variant="outline"
                  nativeButton={false}
                  render={
                    <Link
                      to={toDashboardPath(
                        toProjectPath(
                          project.kind === "zelavis" ? "/website" : "/",
                          project.id,
                        ),
                      )}
                      viewTransition
                    />
                  }
                >
                  <Globe2 className="size-4" />
                  {project.kind === "zelavis" ? "Website" : "Manage"}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </section>
  );
}

export default ProjectsRoute;
