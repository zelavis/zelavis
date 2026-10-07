import { Effect } from "effect";
import { present, integrationValue } from "../core/runtime/effect-boundary.js";
import type { AssistantProjectReader } from "../assistant-tools.js";
import {
  projectRuntimePermissions,
  type ProjectForwardOptions,
} from "./project-gateway.js";
import type { ZelavisRouteResponse } from "../core/index.js";

/**
 * The Assistant's route into a Project: the Gateway's own forwarder, carrying
 * only the database read authority the caller already holds for that Project.
 * The Project runtime checks it again, so a mistake here cannot widen access.
 */
export function createAssistantProjectReader(
  forward: (options: ProjectForwardOptions) => Promise<ZelavisRouteResponse>,
): AssistantProjectReader {
  return ({ projectId, principal, method, path, query, body }) => present(Effect.gen(function* () {
    const response = (yield* integrationValue(forward({
      projectId,
      wildcardPath: path,
      query: query ?? new URLSearchParams(),
      request: new Request("http://project.invalid/", {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      }),
      principal,
      permissions: projectRuntimePermissions(principal, projectId).filter(
        (permission) => permission === "database.inspect" || permission === "database.read",
      ),
      allowFrontend: false,
    })));
    let parsed: unknown = response.body;
    if (response.body instanceof Uint8Array) {
      try {
        parsed = JSON.parse(new TextDecoder().decode(response.body));
      } catch {
        parsed = undefined;
      }
    }
    return { status: response.status ?? 200, body: parsed };
  }));
}
