import { Effect } from "effect";
import type { ZelavisServerRoute } from "../core/index.js";
import { present } from "../core/runtime/effect-boundary.js";
import { CloudCapacityError, type CloudCapacityController } from "./cloud-capacity.js";

/**
 * HTTP for cloud capacity: `/runtime/cloud`.
 *
 * One provider connection and the machines requested through it. Every route needs
 * an explicit permission at system scope; connecting needs `server.cloud.connect`,
 * the strongest, since a token can create and delete machines in its cloud project.
 * The token is accepted once and never appears in any response. Without a controller
 * (no engine is composed into this installation) every route answers 503.
 */

const noStore = { "cache-control": "no-store" } as const;
const isObject = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const bad = (message: string) => ({ status: 400, headers: noStore, body: { error: message } });

function answerFor(error: CloudCapacityError) {
  const body = { error: error.message, code: error.code };
  switch (error.code) {
    case "invalid-request": return { status: 400, headers: noStore, body };
    case "not-connected": return { status: 409, headers: noStore, body };
    case "already-connected": return { status: 409, headers: noStore, body };
    case "has-nodes": return { status: 409, headers: noStore, body };
    case "audit-unavailable": return { status: 503, headers: noStore, body };
    case "provider-failed": return { status: 502, headers: noStore, body: { error: "The cloud provider refused or failed the request.", code: error.code } };
  }
}

export function createCloudRoutes(options: { readonly controller?: CloudCapacityController }): readonly ZelavisServerRoute<any>[] {
  const { controller } = options;
  const unavailable = { status: 503, headers: noStore, body: { error: "Cloud capacity is not available in this installation.", code: "cloud-unavailable" } };
  const system = { type: "system" as const };

  return [
    {
      id: "runtime.cloud.read", method: "GET", path: "/cloud",
      access: { permissions: ["server.cloud.view"], scope: system },
      spec: { operationId: "getCloud", summary: "Read the cloud provider connection", tags: ["cloud"],
        responses: { 200: { description: "The connection, without its token, or null" } } },
      handler: () => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        return yield* controller.connection().pipe(
          Effect.map((connection) => ({ headers: noStore, body: { connection: connection ?? null } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.connect", method: "POST", path: "/cloud/connection",
      access: { permissions: ["server.cloud.connect"], scope: system },
      spec: { operationId: "connectCloud", summary: "Connect a cloud provider with an API token", tags: ["cloud"],
        responses: { 201: { description: "Connected; the token is not returned" }, 400: { description: "Invalid request" },
          409: { description: "Already connected" }, 502: { description: "The provider refused the token" } } },
      handler: ({ body, principal }) => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        if (!isObject(body) || typeof body.provider !== "string" || typeof body.token !== "string") return bad("provider and token are required.");
        if (body.label !== undefined && typeof body.label !== "string") return bad("label must be a string.");
        return yield* controller.connect({
          provider: body.provider, token: body.token, principalId: principal?.id ?? "unknown",
          ...(body.label === undefined ? {} : { label: body.label as string }),
        }).pipe(
          Effect.map((connection) => ({ status: 201, headers: noStore, body: { connection } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.disconnect", method: "DELETE", path: "/cloud/connection",
      access: { permissions: ["server.cloud.connect"], scope: system },
      spec: { operationId: "disconnectCloud", summary: "Forget the provider token; refused while machines exist", tags: ["cloud"],
        responses: { 200: { description: "Disconnected" }, 409: { description: "Not connected, or machines still exist" } } },
      handler: ({ principal }) => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        return yield* controller.disconnect(principal?.id ?? "unknown").pipe(
          Effect.map(() => ({ headers: noStore, body: { disconnected: true } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.scaling.read", method: "GET", path: "/cloud/scaling",
      access: { permissions: ["server.cloud.view"], scope: system },
      spec: { operationId: "getCloudScaling", summary: "Read whether Zelavis may request machines by itself", tags: ["cloud"],
        responses: { 200: { description: "Consent, limits and what the last look at demand did" } } },
      handler: () => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        return yield* controller.scaling().pipe(
          Effect.map((scaling) => ({ headers: noStore, body: { scaling } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.scaling.set", method: "PUT", path: "/cloud/scaling",
      access: { permissions: ["server.cloud.connect"], scope: system },
      spec: { operationId: "setCloudScaling", summary: "Allow or forbid automatic machine requests, with limits", tags: ["cloud"],
        responses: { 200: { description: "Saved" }, 400: { description: "Invalid request" }, 409: { description: "Not connected" } } },
      handler: ({ body, principal }) => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        if (!isObject(body) || typeof body.consent !== "boolean" || typeof body.maxMachines !== "number" || typeof body.cooldownMinutes !== "number") {
          return bad("consent, maxMachines and cooldownMinutes are required.");
        }
        return yield* controller.setScaling({
          consent: body.consent, maxMachines: body.maxMachines, cooldownMinutes: body.cooldownMinutes,
          principalId: principal?.id ?? "unknown",
        }).pipe(
          Effect.map((settings) => ({ headers: noStore, body: { settings } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.nodes.list", method: "GET", path: "/cloud/nodes",
      access: { permissions: ["server.cloud.view"], scope: system },
      spec: { operationId: "listCloudNodes", summary: "List machines this Platform created in its cloud", tags: ["cloud"],
        responses: { 200: { description: "Machines" }, 409: { description: "Not connected" } } },
      handler: () => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        return yield* controller.nodes().pipe(
          Effect.map((nodes) => ({ headers: noStore, body: { nodes } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.nodes.request", method: "POST", path: "/cloud/nodes",
      access: { permissions: ["server.cloud.manage"], scope: system },
      spec: { operationId: "requestCloudNode", summary: "Create a machine that enrolls itself as a worker", tags: ["cloud"],
        responses: { 202: { description: "Requested; poll the machine until it is ready" }, 400: { description: "Invalid request" },
          409: { description: "Not connected" }, 502: { description: "The provider failed" } } },
      handler: ({ body, principal }) => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        if (!isObject(body) || typeof body.requestId !== "string") return bad("A requestId is required.");
        if (body.region !== undefined && typeof body.region !== "string") return bad("region must be a string.");
        const resources = body.resources;
        if (resources !== undefined && !isObject(resources)) return bad("resources must be an object.");
        return yield* controller.request({
          requestId: body.requestId, principalId: principal?.id ?? "unknown",
          ...(body.region === undefined ? {} : { region: body.region as string }),
          ...(resources === undefined ? {} : { resources: resources as never }),
        }).pipe(
          Effect.map((node) => ({ status: 202, headers: noStore, body: { node } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
    {
      id: "runtime.cloud.nodes.release", method: "DELETE", path: "/cloud/nodes/:id",
      access: { permissions: ["server.cloud.manage"], scope: system },
      spec: { operationId: "releaseCloudNode", summary: "Delete a machine this Platform created", tags: ["cloud"],
        responses: { 200: { description: "Released" }, 409: { description: "Not connected" } } },
      handler: ({ params, principal }) => present(Effect.gen(function* () {
        if (!controller) return unavailable;
        return yield* controller.release({ nodeId: params.id ?? "", principalId: principal?.id ?? "unknown" }).pipe(
          Effect.map(() => ({ headers: noStore, body: { released: true } })),
          Effect.catchTag("CloudCapacityError", (error) => Effect.succeed(answerFor(error))),
        );
      })),
    },
  ];
}
