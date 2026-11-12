import { Effect } from "effect";
import { projectConfig, projects, request, type ApiError, type Config, type Project } from "./api.ts";
import { empty } from "./dom.ts";
import type { ScreenContext } from "./screens.ts";

/**
 * What a Project page needs before it can draw: the Project, and, when it runs, its own runtime's configuration.
 * It also keeps the sidebar's Project list and Project slide current, which every Project page owes the shell.
 */
export const projectContext = Effect.fn("ui.projectContext")(function*(context: ScreenContext, options?: { optionalRuntime?: boolean }) {
  const list = yield* projects(context.config);
  context.projectsNavigation(list);
  const project = list.find(entry => entry.id === context.projectId);
  if (!project) {
    if (!options?.optionalRuntime) {
      yield* request(`${context.config.api.basePath}/runtime/projects/${encodeURIComponent(context.projectId ?? "")}`).pipe(
        Effect.catch(error => error.status === 404 ? Effect.void : Effect.fail(error)));
    }
    return { missing: empty("Project not found", "This URL does not identify a project in this installation.") } as const;
  }
  let scoped: Config | undefined;
  let runtimeError: ApiError | undefined;
  if (project.status === "running") {
    const result = yield* Effect.result(projectConfig(context.config, project.id));
    if (result._tag === "Success") scoped = result.success;
    else if (options?.optionalRuntime) runtimeError = result.failure;
    else return yield* Effect.fail(result.failure);
  }
  context.projectNavigation(project, scoped);
  return { project, scoped, runtimeError } as { project: Project; scoped: Config | undefined; runtimeError?: ApiError; missing?: undefined };
});

/** What a page that needs the Project's own runtime shows while it is not running. */
export const notRunning = () => empty("Project runtime is stopped", "Start the project to access its own database, authentication, storage, and workloads.");
