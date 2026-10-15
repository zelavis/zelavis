import { Effect } from "effect";
import type { ApiError, Config, Project } from "./api.ts";
import { empty } from "./dom.ts";
import { assistantScreen } from "./assistant-pages.ts";
import { loginScreen, logoutScreen, setupScreen } from "./auth-pages.ts";
import { fabricScreen } from "./fabric-pages.ts";
import { hostScreens } from "./host-pages.ts";
import { marketplaceScreen as platformMarketplace } from "./marketplace-pages.ts";
import { notRunning, projectContext } from "./project-context.ts";
import { handlesProjectPath, projectPagesScreen } from "./project-pages.ts";
import { projectsOverviewScreen } from "./projects-pages.ts";
import { servicePageScreen } from "./service-pages.ts";
import { logsScreen, terminalScreen } from "./server-pages.ts";
import { servicesScreen, settingsScreen } from "./settings-pages.ts";

export interface ScreenContext {
  config: Config;
  url: URL;
  path: string;
  projectId?: string;
  section?: string;
  projectsNavigation(projects: readonly Project[]): void;
  projectNavigation(project: Project, runtime?: Config, menu?: unknown): void;
  navigate(path: string): void;
  run<A>(effect: Effect.Effect<A, ApiError>, success?: (value: A) => void): void;
  refresh(): void;
  setSearch(values: Record<string, string | undefined>): void;
}
export const loadScreen = Effect.fn("new-ui.loadScreen")(function*(context: ScreenContext) {
  if (context.path === "/assistant") return yield* assistantScreen(context);
  if (context.path === "/login") return yield* loginScreen(context);
  if (context.path === "/setup") return yield* setupScreen(context);
  if (context.path === "/logout") return yield* logoutScreen(context);
  if (context.path === "/server/logs") return yield* logsScreen(context);
  if (context.path === "/server/terminal") return yield* terminalScreen(context);
  if (context.path === "/" || context.path === "/projects") return yield* projectsOverviewScreen(context);
  if (context.path.startsWith("/settings")) return yield* settingsScreen(context);
  if (context.path === "/services") return yield* servicesScreen(context);
  if (context.path === "/marketplace") return yield* platformMarketplace(context, "platform");
  if (context.projectId && /^\/projects\/[^/]+\/marketplace\/?$/.test(context.path)) {
    const entered = yield* projectContext(context);
    if (entered.missing) return entered.missing;
    return entered.scoped ? yield* platformMarketplace(context, "project", entered.scoped) : notRunning();
  }
  if (handlesProjectPath(context)) return yield* projectPagesScreen(context);
  if (/^\/server\/fabric(\/|$)/.test(context.path)) return yield* fabricScreen(context);
  const hostScreen = (hostScreens as Record<string, typeof logsScreen>)[context.path.replace(/(.)\/$/, "$1")];
  if (hostScreen) return yield* hostScreen(context);
  const servicePage = yield* servicePageScreen(context.config, context.path);
  if (servicePage) return servicePage;
  return empty("Page not found", "Choose a section from the sidebar to continue.");
});
