import type {
  ZelavisAnyServiceInput,
  ZelavisServiceInput,
  ZelavisServerOptions,
  ZelavisServerRuntime,
  ZelavisServerService,
} from "../contracts.js";
import { resolveMountedEndpoints } from "./resolve-endpoints.js";

async function resolveServiceInput<TService = unknown>(
  input: ZelavisServiceInput<TService>,
): Promise<ZelavisServerService<TService>>;
async function resolveServiceInput(input: ZelavisAnyServiceInput): Promise<ZelavisServerService<any>>;
async function resolveServiceInput(
  input: ZelavisAnyServiceInput,
): Promise<ZelavisServerService<any>> {
  const service = await input;

  if (!service.services?.length) {
    return service;
  }

  const services = await Promise.all(
    service.services.map((child) => resolveServiceInput(child)),
  );

  return {
    ...service,
    services,
  };
}

function toServiceMap<TService = unknown>(
  services: readonly ZelavisServerService<TService>[],
): Record<string, ZelavisServerService<any>> {
  const result: Record<string, ZelavisServerService<any>> = {};

  for (const service of services) {
    result[service.name] = service;
  }

  return result;
}

export async function zelavisServer<TService = unknown, TResult = unknown>(
  options: ZelavisServerOptions<TService, TResult>,
): Promise<ZelavisServerRuntime<TService, TResult>> {
  const services = await Promise.all(options.services.map(resolveServiceInput));
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
