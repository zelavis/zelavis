import type {
  ZelavisAnyRuntimeServiceInput,
  ZelavisRuntimeServiceInput,
  ZelavisServerDispatchHandler,
  ZelavisServerFetchHandler,
  ZelavisServerOptions,
  ZelavisServerPlainHandler,
  ZelavisServerRuntime,
  ZelavisRuntimeService,
} from "./contracts.js";
import {
  toDefaultErrorResponse,
  createZelavisDispatcher,
  createZelavisFetchHandler,
  createZelavisPlainHandler,
} from "./request-dispatcher.js";
import { resolveMountedEndpoints } from "./resolve-endpoints.js";
import { defineCompatibilityDate } from "./compatibility.js";
import { createServerLifecycle } from "./lifecycle.js";
import { composeRequestAuthenticators } from "./authentication.js";
import type { ZelavisRequestAuthenticator } from "./authentication.js";

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

function collectAuthenticators(
  services: readonly ZelavisRuntimeService<any>[],
): ZelavisRequestAuthenticator[] {
  return services.flatMap((service) => [
    ...(service.authenticators ?? []),
    ...collectAuthenticators((service.services ?? []) as readonly ZelavisRuntimeService<any>[]),
  ]);
}

async function runFinalizers(
  finalizers: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> {
  const errors: unknown[] = [];

  for (const finalize of finalizers) {
    try {
      await finalize();
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Multiple Zelavis server finalizers failed.",
    );
  }
}

export async function createServiceRuntime<TService = unknown>(
  options: ZelavisServerOptions<TService>,
): Promise<ZelavisServerRuntime<TService>> {
  const compatibilityDate = options.compatibilityDate
    ? defineCompatibilityDate(options.compatibilityDate)
    : undefined;
  const lifecycle = createServerLifecycle<TService>();
  const cleanups = [] as Array<() => void | Promise<void>>;

  try {
    for (const plugin of options.plugins ?? []) {
      const cleanup = await plugin({
        hooks: lifecycle,
        compatibilityDate,
      });
      if (typeof cleanup === "function") {
        cleanups.push(cleanup);
      }
    }

    const services = await Promise.all(
      options.services.map(resolveServiceInput),
    );
    const resolvedRoutes = resolveMountedEndpoints(services, {
      prefix: options.prefix,
      version: options.version,
      servicePrefixes: options.servicePrefixes,
      pathOverrides: options.pathOverrides,
    });
    const serviceMap = toServiceMap(services);
    const serviceAuthenticators = collectAuthenticators(services) as ZelavisRequestAuthenticator<TService>[];
    const resolvePrincipal = composeRequestAuthenticators<TService>([
      ...(options.resolvePrincipal
        ? [{ name: "host", authenticate: options.resolvePrincipal }]
        : []),
      ...serviceAuthenticators,
    ]);
    const baseDispatch = createZelavisDispatcher(resolvedRoutes, {
      authorize: options.authorize,
      onError: async ({ error, request, executionContext, resolvedRoute }) => {
        await lifecycle.emit("error", {
          error,
          request,
          context: executionContext,
          resolvedRoute,
        });
        return (
          (await options.onError?.({
            error,
            request,
            executionContext,
            resolvedRoute,
          })) ?? toDefaultErrorResponse(error)
        );
      },
      resolvePrincipal,
    }) as ZelavisServerDispatchHandler<TService>;
    const dispatch: ZelavisServerDispatchHandler<TService> = async (
      request,
      context,
    ) => {
      await lifecycle.emit("request", { request, context });
      try {
        const result = await baseDispatch(request, context);
        await lifecycle.emit("response", { request, context, result });
        return result;
      } catch (error) {
        await lifecycle.emit("error", { error, request, context });
        throw error;
      }
    };
    const fetch = createZelavisFetchHandler(
      dispatch,
    ) as ZelavisServerFetchHandler<TService>;
    const plain = createZelavisPlainHandler(
      dispatch,
    ) as ZelavisServerPlainHandler<TService>;
    let closePromise: Promise<void> | undefined;

    await lifecycle.emit("start", {
      services: serviceMap,
      routes: resolvedRoutes,
      compatibilityDate,
    });

    return {
      services: serviceMap,
      routes: resolvedRoutes,
      compatibilityDate,
      hooks: lifecycle,
      dispatch,
      fetch,
      plain,
      close() {
        closePromise ??= (async () => {
          await runFinalizers([
            () => lifecycle.emit("close", { compatibilityDate }),
            ...[...cleanups].reverse(),
          ]);
        })();
        return closePromise;
      },
    };
  } catch (error) {
    try {
      await runFinalizers([...cleanups].reverse());
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Zelavis server startup and plugin cleanup both failed.",
      );
    }
    throw error;
  }
}
