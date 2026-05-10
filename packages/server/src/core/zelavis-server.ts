import type {
  ZelavisAnyServiceInput,
  ZelavisServiceInput,
  ZelavisServerDispatchHandler,
  ZelavisServerFetchHandler,
  ZelavisServerOptions,
  ZelavisServerPlainHandler,
  ZelavisServerRuntime,
  ZelavisService,
} from "../contracts.js";
import {
  createZelavisDispatcher,
  createZelavisFetchHandler,
  createZelavisPlainHandler,
} from "./request-dispatcher.js";
import { resolveMountedEndpoints } from "./resolve-endpoints.js";

async function resolveServiceInput<TService = unknown>(
  input: ZelavisServiceInput<TService>,
): Promise<ZelavisService<TService>>;
async function resolveServiceInput(
  input: ZelavisAnyServiceInput,
): Promise<ZelavisService<any>>;
async function resolveServiceInput(
  input: ZelavisAnyServiceInput,
): Promise<ZelavisService<any>> {
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
  services: readonly ZelavisService<TService>[],
): Record<string, ZelavisService<any>> {
  const result: Record<string, ZelavisService<any>> = {};

  for (const service of services) {
    result[service.name] = service;
  }

  return result;
}

export async function zelavisServer<TService = unknown>(
  options: ZelavisServerOptions<TService>,
): Promise<ZelavisServerRuntime<TService>> {
  const services = await Promise.all(options.services.map(resolveServiceInput));
  const resolvedRoutes = resolveMountedEndpoints(services, {
    prefix: options.prefix,
    version: options.version,
    servicePrefixes: options.servicePrefixes,
    pathOverrides: options.pathOverrides,
  });
  const dispatch = createZelavisDispatcher(resolvedRoutes, {
    onError: options.onError,
  }) as ZelavisServerDispatchHandler<TService>;
  const fetch = createZelavisFetchHandler(
    dispatch,
  ) as ZelavisServerFetchHandler<TService>;
  const plain = createZelavisPlainHandler(
    dispatch,
  ) as ZelavisServerPlainHandler<TService>;

  return {
    services: toServiceMap(services),
    routes: resolvedRoutes,
    dispatch,
    fetch,
    plain,
  };
}
