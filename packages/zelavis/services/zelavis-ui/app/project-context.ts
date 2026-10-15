import { Effect } from "effect";
import { projectConfig, projects, type Config, type Project } from "./api.ts";
import { empty } from "./dom.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * What a Project page needs before it can draw: the Project, and, when it runs, its own runtime's configuration.
 * It also keeps the sidebar's Project list and Project slide current, which every Project page owes the shell.
 */
export const projectContext = Effect.fn("ui.projectContext")(function*(context: ScreenContext) {
  const list = yield* projects(context.config);
  context.projectsNavigation(list);
  const project = list.find(entry => entry.id === context.projectId);
  if (!project) return { missing: empty("Project not found", "This URL does not identify a project in this installation.") } as const;
  const scoped: Config | undefined = project.status === "running" ? yield* projectConfig(context.config, project.id) : undefined;
  context.projectNavigation(project, scoped);
  return { project, scoped } as { project: Project; scoped: Config | undefined; missing?: undefined };
});

/** What a page that needs the Project's own runtime shows while it is not running. */
export const notRunning = () => empty("Project runtime is stopped", "Start the project to access its own database, authentication, storage, and workloads.");
