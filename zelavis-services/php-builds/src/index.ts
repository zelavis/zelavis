import { randomBytes } from "node:crypto";
import { zelavis } from "zelavis/sdk";
import { BuildError, createBuilds, type Builds } from "./builds.js";

/**
 * PHP Builds: build the PHP the Zelavis recipes run on this server, and publish it to a mirror.
 *
 * The API (`plugins.phpBuilds` in the SDK, `/zelavis/api/v1/plugins/phpBuilds` over HTTP, `zelavis plugins phpBuilds`
 * on the command line) is one set of operations the dashboard page calls like any other client. This package has no
 * authority of its own: it asks the host for the fixed operations its manifest names, with the caller's principal.
 */

const VIEW = { permissions: ["server.php-builds.view"], scope: { type: "system" as const } };
const RUN = { permissions: ["server.php-builds.run"], scope: { type: "system" as const } };

const UNAVAILABLE = {
  status: 503,
  body: { error: "PHP Builds needs the host operation Agent of a system installation, and a Platform store." },
};

export function register() {
  let builds: Builds | undefined;
  zelavis.setup((context) => {
    const operations = context.core.hostOperations;
    const store = context.core.store;
    if (!operations || !store) return;
    builds = createBuilds({
      operations, store,
      environment: (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {},
      now: () => new Date(),
      newJob: () => randomBytes(8).toString("hex"),
    });
  });

  /** Runs a handler against the builds service and turns its failures into the response they mean. */
  const answer = (status: number, run: (service: Builds, context: any) => Promise<unknown>) => async (context: any) => {
    if (!builds) return UNAVAILABLE;
    try {
      return { status, body: await run(builds, context) };
    } catch (error) {
      if (error instanceof BuildError) return { status: error.status, body: { error: error.message } };
      return { status: 500, body: { error: "The request could not be completed." } };
    }
  };

  zelavis.plugins.ui.menus.create({
    title: "PHP Builds",
    path: "/php-builds",
    page: { id: "builds", file: "builds.html" },
  });

  zelavis.operations.create({
    id: "phpBuilds.host.get", resource: "host", action: "get", method: "GET", path: "/host", access: VIEW,
    spec: { operationId: "getPhpBuildHost", summary: "What this host can build with, and whether the mirror is configured" },
    handler: answer(200, (service, { principal }) => service.host(principal)),
  });
  zelavis.operations.create({
    id: "phpBuilds.builds.list", resource: "builds", action: "list", method: "GET", path: "/builds", access: VIEW,
    spec: { operationId: "listPhpBuilds", summary: "Recent builds, newest first" },
    handler: answer(200, async (service) => ({ builds: await service.list() })),
  });
  zelavis.operations.create({
    id: "phpBuilds.builds.create", resource: "builds", action: "create", method: "POST", path: "/builds", access: RUN,
    spec: {
      operationId: "startPhpBuild", summary: "Start a PHP build in a resource-limited container on this host",
      requestBody: { required: true, schema: { type: "object", required: ["php"], properties: { php: { type: "string", description: "An exact version, such as 8.4.23" } } } },
    },
    handler: answer(201, (service, { principal, body }) => service.start(principal, body)),
  });
  zelavis.operations.create({
    id: "phpBuilds.builds.get", resource: "builds", action: "get", method: "GET", path: "/builds/:id", access: VIEW,
    spec: { operationId: "getPhpBuild", summary: "One build, refreshed from the host: state, log tail, archives and uploads" },
    handler: answer(200, (service, { principal, params }) => service.get(principal, params.id ?? "")),
  });
  zelavis.operations.create({
    id: "phpBuilds.builds.upload", resource: "builds", action: "upload", method: "POST", path: "/builds/:id/upload", access: RUN,
    spec: { operationId: "uploadPhpBuild", summary: "Publish a finished build's archives to the configured mirror" },
    handler: answer(202, (service, { principal, params }) => service.upload(principal, params.id ?? "")),
  });
  zelavis.operations.create({
    id: "phpBuilds.builds.delete", resource: "builds", action: "delete", method: "DELETE", path: "/builds/:id", access: RUN,
    spec: { operationId: "cleanPhpBuild", summary: "Stop a build if it runs and remove its container and output" },
    handler: answer(200, (service, { principal, params }) => service.clean(principal, params.id ?? "")),
  });
}
