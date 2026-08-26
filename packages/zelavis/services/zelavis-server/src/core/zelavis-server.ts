import type {
  ZelavisAnyRuntimeServiceInput,
  ZelavisRuntimeServiceInput,
  ZelavisServerDispatchHandler,
  ZelavisServerFetchHandler,
  ZelavisServerOptions,
  ZelavisServerPlainHandler,
  ZelavisServerRuntime,
  ZelavisRuntimeService,
} from "../contracts.js";
import {
  createZelavisDispatcher,
  createZelavisFetchHandler,
  createZelavisPlainHandler,
} from "./request-dispatcher.js";
import { resolveMountedEndpoints } from "./resolve-endpoints.js";

async function resolveServiceInput<TService = unknown>(
  input: ZelavisRuntimeServiceInput<TService>,
): Promise<ZelavisRuntimeService<TService>>;
async function resolveServiceInput(
  input: ZelavisAnyRuntimeServiceInput,
): Promise<ZelavisRuntimeService<any>>;
async function resolveServiceInput(
  input: ZelavisAnyRuntimeServiceInput,
): Promise<ZelavisRuntimeService<any>> {
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
  services: readonly ZelavisRuntimeService<TService>[],
): Record<string, ZelavisRuntimeService<any>> {
  const result: Record<string, ZelavisRuntimeService<any>> = {};

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
    authorize: options.authorize,
    onError: options.onError,
    resolvePrincipal: options.resolvePrincipal,
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
