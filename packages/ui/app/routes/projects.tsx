import type * as React from "react";
import { Link } from "react-router";
import {
  Clock3,
  Globe2,
  LayoutDashboard,
  Plus,
  Search,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  DataRow,
  PageHeader,
  ResourceNotice,
  StatusBadge,
} from "#/components/DashboardPage";
import { Button, buttonVariants } from "#/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Input } from "#/components/ui/input";
import {
  dashboardProjects,
  type DashboardProjectItem,
} from "#/lib/dashboard-data";
import { toDashboardPath, toProjectPath } from "#/lib/routing";
import { parseAsString, useTypedSearchParams } from "#/lib/use-typed-search-params";
import { cn } from "#/lib/utils";

export const handle = {
  pageLabel: "Projects",
} as const;

const projectSearchSchema = {
  q: parseAsString.withDefault(""),
  new: parseAsString.withDefault(""),
} as const;

function slugifyProjectName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ProjectsRoute() {
  const [{ q, new: createMode }, setParams] =
    useTypedSearchParams(projectSearchSchema);
  const [projects, setProjects] = useState<DashboardProjectItem[]>([
    ...dashboardProjects,
  ]);
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const showCreate = createMode === "1";

  const filteredProjects = useMemo(() => {
    const query = q.trim().toLowerCase();

    if (!query) {
      return projects;
    }

    return projects.filter((project) =>
      [project.name, project.domain].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [projects, q]);

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
    if (!id) {
      setError("Project name must contain letters or numbers.");
      return;
    }

    if (projects.some((project) => project.id === id)) {
      setError("A project with that name already exists.");
      return;
    }

    const nextProject: DashboardProjectItem = {
      id,
      name: trimmedName,
      logo: Globe2,
      domain: domain.trim() || "localhost",
      status: "draft",
      updatedAt: "just now",
    };

    setProjects((current) => [nextProject, ...current]);
    setName("");
    setDomain("");
    setParams({ new: null });
    setMessage(`Created ${nextProject.name}.`);
  }

  return (
    <section className="mx-auto grid w-full max-w-7xl gap-6">
      <PageHeader
        eyebrow="Projects"
        title="Projects"
        description="Each project owns one dashboard and one local website."
        actions={
          <Button type="button" onClick={() => setParams({ new: "1" })}>
            <Plus className="size-4" />
            New project
          </Button>
        }
      />

      {showCreate ? (
        <Card>
          <CardHeader>
            <CardTitle>Create project</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-4 p-4">
            <form className="grid gap-4 md:grid-cols-[1fr_1fr_auto]" onSubmit={handleCreateProject}>
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
                  onClick={() => setParams({ new: null })}
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
        <p className="text-sm text-muted-foreground">
          {filteredProjects.length} of {projects.length} projects
        </p>
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
                label="Website"
                detail={project.domain}
                meta={<Globe2 className="size-4 text-muted-foreground" />}
              />
              <DataRow
                label="Updated"
                detail={project.updatedAt}
                meta={<Clock3 className="size-4 text-muted-foreground" />}
              />
              <div className="flex items-center justify-between gap-2 px-4 py-3">
                <Link
                  to={toDashboardPath(toProjectPath("/"))}
                  className={cn(buttonVariants({ size: "sm" }))}
                >
                  <LayoutDashboard className="size-4" />
                  Open
                </Link>
                <Link
                  to={toDashboardPath(toProjectPath("/website"))}
                  className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
                >
                  <Globe2 className="size-4" />
                  Website
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
    </section>
  );
}

export default ProjectsRoute;
