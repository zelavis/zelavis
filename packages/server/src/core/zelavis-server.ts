import type {
  ZelavisServerOptions,
  ZelavisServerRuntime,
  ZelavisServerService,
} from "../contracts.js";
import { resolveMountedEndpoints } from "./resolve-endpoints.js";

function toServiceMap<TService = unknown>(
  services: readonly ZelavisServerService<TService>[],
): Record<string, ZelavisServerService<TService>> {
  const result: Record<string, ZelavisServerService<TService>> = {};

  for (const service of services) {
    result[service.name] = service;
  }

  return result;
}

export async function zelavisServer<TService = unknown, TResult = unknown>(
  options: ZelavisServerOptions<TService, TResult>,
): Promise<ZelavisServerRuntime<TService, TResult>> {
  const services = await Promise.all(options.services);
  const resolvedRoutes = resolveMountedEndpoints(services, {
    prefix: options.prefix,
    version: options.version,
    servicePrefixes: options.servicePrefixes,
    pathOverrides: options.pathOverrides,
  });

  const server = options.integration.mount(resolvedRoutes, {
    onError: options.onError,
  });

  return {
    services: toServiceMap(services),
    server,
  };
}
