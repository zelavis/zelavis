import type {
  ZelavisEdgeCapability,
  ZelavisEdgeHostname,
  ZelavisEdgePublication,
  ZelavisEdgeRoute,
  ZelavisEdgeRouteProtocol,
  ZelavisEdgeTlsMode,
} from "../edge/index.js";
import { createZelavisClient } from "../sdk/fetch.js";

const usage =
  "zelavis edge <status|plan|switch|publish|routes> [args] [--url URL] [--token TOKEN] [--json]\n" +
  "  zelavis edge status\n" +
  "  zelavis edge plan <adapter> --publication ID@REVISION [--routes N] [--require CAP] [--certificate-ref REF]\n" +
  "  zelavis edge switch <adapter> --publication ID@REVISION [--routes N] [--require CAP] [--certificate-ref REF]\n" +
  "  zelavis edge publish\n" +
  "  zelavis edge routes [list] [--scope platform|project] [--project-id ID] [--hostname HOST]\n" +
  "  zelavis edge routes put <id> --hostname HOST --target URL [--weight N] [--protocol P] [--tls managed|external|none] [--certificate-ref REF] [--priority N] [--path-prefix /...] [--exact] [--project-id ID] [--scope platform|project]\n" +
  "  zelavis edge routes delete <id>";

const capabilities = new Set<ZelavisEdgeCapability>([
  "http",
  "https",
  "tcp",
  "udp",
  "websocket",
  "sse",
  "http3",
  "active-health-checks",
  "weighted-targets",
  "connection-draining",
  "certificate-hot-reload",
]);

const knownFlags = new Set([
  "--url",
  "--token",
  "--publication",
  "--routes",
  "--require",
  "--certificate-ref",
  "--hostname",
  "--target",
  "--weight",
  "--protocol",
  "--tls",
  "--priority",
  "--path-prefix",
  "--project-id",
  "--scope",
]);

function parsePublication(value: string): Pick<ZelavisEdgePublication, "id" | "revision"> {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--publication requires ID@REVISION.");
  }
  return { id: value.slice(0, separator), revision: value.slice(separator + 1) };
}

/** `zelavis edge` uses the same client contract as the dashboard and API. */
export async function runEdgeCommand(args: readonly string[]): Promise<void> {
  const positional: string[] = [];
  let url = "http://localhost:3000/zelavis";
  let token: string | undefined;
  let publication: Pick<ZelavisEdgePublication, "id" | "revision"> | undefined;
  let routeCount = 0;
  let json = false;
  const requiredCapabilities: ZelavisEdgeCapability[] = [];
  const certificateRefs: string[] = [];

  let hostnameFlag: string | undefined;
  let targetFlag: string | undefined;
  let weightFlag: number | undefined;
  const protocolsFlag: ZelavisEdgeRouteProtocol[] = [];
  let tlsFlag: ZelavisEdgeTlsMode | undefined;
  let priorityFlag: number | undefined;
  let pathPrefixFlag: string | undefined;
  let exactFlag = false;
  let projectIdFlag: string | undefined;
  let scopeFlag: "platform" | "project" | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--json") { json = true; continue; }
    if (argument === "--exact") { exactFlag = true; continue; }
    if (argument === "--help" || argument === "-h") {
      console.log(usage);
      return;
    }
    if (!argument.startsWith("-")) { positional.push(argument); continue; }
    const separator = argument.indexOf("=");
    const flag = separator === -1 ? argument : argument.slice(0, separator);
    if (!knownFlags.has(flag)) {
      throw new Error(`Unknown edge option "${argument}".`);
    }
    const value = separator === -1 ? args[++index] : argument.slice(separator + 1);
    if (!value) throw new Error(`${flag} requires a value.`);
    if (flag === "--url") url = value;
    if (flag === "--token") token = value;
    if (flag === "--publication") publication = parsePublication(value);
    if (flag === "--routes") {
      routeCount = Number(value);
      if (!Number.isSafeInteger(routeCount) || routeCount < 0) {
        throw new Error("--routes requires a non-negative integer.");
      }
    }
    if (flag === "--require") {
      if (!capabilities.has(value as ZelavisEdgeCapability)) {
        throw new Error(`Unknown Edge capability "${value}".`);
      }
      requiredCapabilities.push(value as ZelavisEdgeCapability);
    }
    if (flag === "--certificate-ref") certificateRefs.push(value);
    if (flag === "--hostname") hostnameFlag = value;
    if (flag === "--target") targetFlag = value;
    if (flag === "--weight") {
      weightFlag = Number(value);
      if (!Number.isSafeInteger(weightFlag) || weightFlag < 1 || weightFlag > 100) {
        throw new Error("--weight requires an integer between 1 and 100.");
      }
    }
    if (flag === "--protocol") {
      if (!["http", "websocket", "sse", "grpc"].includes(value)) {
        throw new Error(`Unknown protocol "${value}". Must be http, websocket, sse, or grpc.`);
      }
      protocolsFlag.push(value as ZelavisEdgeRouteProtocol);
    }
    if (flag === "--tls") {
      if (!["managed", "external", "none"].includes(value)) {
        throw new Error(`Unknown TLS mode "${value}". Must be managed, external, or none.`);
      }
      tlsFlag = value as ZelavisEdgeTlsMode;
    }
    if (flag === "--priority") {
      priorityFlag = Number(value);
      if (!Number.isSafeInteger(priorityFlag)) {
        throw new Error("--priority requires a safe integer.");
      }
    }
    if (flag === "--path-prefix") pathPrefixFlag = value;
    if (flag === "--project-id") projectIdFlag = value;
    if (flag === "--scope") {
      if (value !== "platform" && value !== "project") {
        throw new Error(`Unknown scope "${value}". Must be platform or project.`);
      }
      scopeFlag = value;
    }
  }

  const [action, ...subArgs] = positional;
  if (!action) {
    console.log(usage);
    return;
  }
  const base = new URL(url);
  const client = createZelavisClient({
    baseUrl: base.origin,
    rootPath: base.pathname,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
  const print = (value: unknown, text: () => string) =>
    console.log(json ? JSON.stringify(value, null, 2) : text());

  if (action === "status") {
    if (subArgs.length > 0) throw new Error(`edge status does not accept arguments. ${usage}`);
    const status = await client.edge.status();
    print(status, () => [
      `Active adapter: ${status.policy.activeAdapterId ?? "none"}`,
      `Desired adapter: ${status.policy.desiredAdapterId}`,
      ...status.adapters.map((adapter) =>
        `${adapter.id}\t${adapter.detection.state}\t${adapter.detection.version ?? "unknown"}${adapter.active ? "\tactive" : ""}`),
      ...(status.activeSwitch
        ? [`Switch ${status.activeSwitch.id}: ${status.activeSwitch.phase}`]
        : []),
    ].join("\n"));
    return;
  }

  if (action === "publish") {
    if (subArgs.length > 0) throw new Error(`edge publish does not accept arguments. ${usage}`);
    const pub = await client.edge.publish();
    print(pub, () =>
      `Published Edge revision ${pub.revision} (${pub.routeCount} routes, ${pub.requiredCapabilities.length} capabilities).`);
    return;
  }

  if (action === "routes") {
    const [routeAction = "list", routeId, ...extra] = subArgs;
    if (extra.length > 0) throw new Error(`Unexpected argument "${extra[0]}". ${usage}`);

    if (routeAction === "list") {
      const result = await client.edge.routes({
        ...(scopeFlag ? { scope: scopeFlag } : {}),
        ...(projectIdFlag ? { projectId: projectIdFlag } : {}),
        ...(hostnameFlag ? { hostname: hostnameFlag } : {}),
      });
      print(result, () => [
        `Current publication: ${result.publication ? `rev ${result.publication.revision} (${result.publication.routeCount} routes)` : "none"}`,
        "",
        "Hostnames:",
        ...(result.hostnames.length > 0
          ? result.hostnames.map((h) => `  ${h.host}\t${h.scope}\t${h.tlsMode}${h.certificateRef ? `\t${h.certificateRef}` : ""}`)
          : ["  (none)"]),
        "",
        "Routes:",
        ...(result.routes.length > 0
          ? result.routes.map((r) => `  ${r.id}\t${r.hostname}${r.pathPrefix}\t${r.targets.map((t) => `${t.url} (${t.weight}%)`).join(", ")}\tpriority:${r.priority}`)
          : ["  (none)"]),
      ].join("\n"));
      return;
    }

    if (routeAction === "delete") {
      if (!routeId) throw new Error(`edge routes delete requires a route id.`);
      const deleted = await client.edge.deleteRoute(routeId);
      print({ deleted }, () =>
        deleted ? `Deleted Edge route "${routeId}".` : `Edge route "${routeId}" was not found.`);
      return;
    }

    if (routeAction === "put") {
      if (!routeId) throw new Error(`edge routes put requires a route id.`);
      if (!hostnameFlag) throw new Error(`edge routes put requires --hostname.`);
      if (!targetFlag) throw new Error(`edge routes put requires --target.`);

      const scope = scopeFlag ?? (projectIdFlag ? "project" : "platform");
      const route: ZelavisEdgeRoute = {
        id: routeId,
        scope,
        ...(projectIdFlag ? { projectId: projectIdFlag } : {}),
        hostname: hostnameFlag,
        pathPrefix: pathPrefixFlag ?? "/",
        pathMatch: exactFlag ? "exact" : "prefix",
        targets: [{ url: targetFlag, weight: weightFlag ?? 100 }],
        protocols: protocolsFlag.length > 0 ? protocolsFlag : ["http"],
        priority: priorityFlag ?? 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      let hostname: ZelavisEdgeHostname | undefined;
      if (tlsFlag) {
        hostname = {
          host: hostnameFlag,
          scope,
          ...(projectIdFlag ? { projectId: projectIdFlag } : {}),
          tlsMode: tlsFlag,
          ...(certificateRefs.length > 0 ? { certificateRef: certificateRefs[0] } : {}),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      }

      const result = await client.edge.putRoute({
        route,
        ...(hostname ? { hostname } : {}),
      });
      print(result, () =>
        `Stored Edge route "${result.route.id}" (${result.route.hostname}${result.route.pathPrefix}).`);
      return;
    }

    throw new Error(`Unknown edge routes command "${routeAction}". ${usage}`);
  }

  if (action !== "plan" && action !== "switch") {
    throw new Error(`Unknown edge command "${action}". ${usage}`);
  }
  const [adapterId, ...rest] = subArgs;
  if (rest.length > 0) throw new Error(`Unexpected argument "${rest[0]}". ${usage}`);
  if (!adapterId) throw new Error(`edge ${action} requires an adapter id.`);
  if (!publication) throw new Error(`edge ${action} requires --publication ID@REVISION.`);
  const input = {
    adapterId,
    publication: {
      ...publication,
      routeCount,
      requiredCapabilities,
      certificateRefs,
    },
  };
  if (action === "plan") {
    const plan = await client.edge.plan(input);
    print({ plan }, () => plan.ready
      ? `Edge switch to ${plan.targetAdapterId} is ready.`
      : `Edge switch to ${plan.targetAdapterId} is not ready: ${[
          plan.detection.detail,
          plan.missingCapabilities.length
            ? `missing ${plan.missingCapabilities.join(", ")}`
            : undefined,
        ].filter(Boolean).join("; ") || plan.detection.state}`);
    return;
  }
  const edgeSwitch = await client.edge.switch(input);
  print({ edgeSwitch }, () =>
    `Edge switch ${edgeSwitch.id} completed with ${edgeSwitch.targetAdapterId}.`);
}
