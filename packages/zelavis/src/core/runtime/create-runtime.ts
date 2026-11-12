import { Cause, Effect } from "effect";
import { present, integration, integrationValue, unwrapFailure, type IntegrationFailure } from "./effect-boundary.js";
import type {
  ZelavisEndpointGroup,
  ZelavisEndpointGroupInput,
  ZelavisAnyRuntimeServiceInput,
  ZelavisRuntimeServiceInput,
  ZelavisServerDispatchHandler,
  ZelavisServerFetchHandler,
  ZelavisServerOptions,
  ZelavisServerPlainHandler,
  ZelavisServerRuntime,
  ZelavisRuntimeService,
} from "./contracts.js";
import { endpointGroupFromService } from "./contracts.js";
import { createErrorCorrelationId } from "./error-policy.js";
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
function resolveServiceInput(
  input: ZelavisAnyRuntimeServiceInput,
): Promise<ZelavisRuntimeService<any>> {
    return present(integration(() => input));
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

function toEndpointGroupMap(
  endpointGroups: readonly ZelavisEndpointGroup<any>[],
): Record<string, ZelavisEndpointGroup<any>> {
  const result: Record<string, ZelavisEndpointGroup<any>> = {};

  for (const endpointGroup of endpointGroups) {
    if (result[endpointGroup.id]) {
      throw new TypeError(`Duplicate endpoint group: ${endpointGroup.id}`);
    }
    result[endpointGroup.id] = endpointGroup;
  }

  return result;
}

function resolveEndpointGroupInput(
  input: ZelavisEndpointGroupInput<any>,
): Promise<ZelavisEndpointGroup<any>> {
    return present(integration(() => input));
  }

function collectAuthenticators(
  endpointGroups: readonly ZelavisEndpointGroup<any>[],
): ZelavisRequestAuthenticator[] {
  return endpointGroups.flatMap(
    (endpointGroup) => endpointGroup.authenticators ?? [],
  );
}

function runFinalizers(
  finalizers: ReadonlyArray<() => void | Promise<void>>,
): Promise<void> {
  return present(Effect.gen(function* () {
    const errors: unknown[] = [];

    for (const finalize of finalizers) {
      yield* integration(() => finalize()).pipe(
        Effect.catch((failure) => Effect.sync(() => { errors.push(unwrapFailure(failure)); })),
      );
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
  }));
}

export function createServiceRuntime<TService = unknown>(
  options: ZelavisServerOptions<TService>,
): Promise<ZelavisServerRuntime<TService>> {
  const compatibilityDate = options.compatibilityDate
    ? defineCompatibilityDate(options.compatibilityDate)
    : undefined;
  const lifecycle = createServerLifecycle<TService>();
  const cleanups = [] as Array<() => void | Promise<void>>;

  return present(Effect.gen(function* (): Effect.fn.Return<ZelavisServerRuntime<TService>, IntegrationFailure> {
    for (const plugin of options.plugins ?? []) {
      const cleanup = yield* integration(() => plugin({
        hooks: lifecycle,
        compatibilityDate,
      }));
      if (typeof cleanup === "function") {
        cleanups.push(cleanup);
      }
    }

    const services = yield* Effect.forEach(
      options.services ?? [],
      (input) => integration(() => resolveServiceInput(input)),
      { concurrency: Math.max(1, options.services?.length ?? 1) },
    );
    const endpointGroups = [
      ...services.map(endpointGroupFromService),
      ...(yield* Effect.forEach(
        options.endpointGroups ?? [],
        (input) => integration(() => resolveEndpointGroupInput(input)),
        { concurrency: Math.max(1, options.endpointGroups?.length ?? 1) },
      )),
    ];
    const resolvedRoutes = resolveMountedEndpoints(endpointGroups, {
      prefix: options.prefix,
      version: options.version,
      servicePrefixes: options.servicePrefixes,
      pathOverrides: options.pathOverrides,
    });
    const serviceMap = toServiceMap(services);
    const endpointGroupMap = toEndpointGroupMap(endpointGroups);
    const serviceAuthenticators = collectAuthenticators(endpointGroups) as ZelavisRequestAuthenticator<TService>[];
    const resolvePrincipal = composeRequestAuthenticators<TService>([
      ...(options.resolvePrincipal
        ? [{ name: "host", authenticate: options.resolvePrincipal }]
        : []),
      ...serviceAuthenticators,
    ]);
    const baseDispatch = createZelavisDispatcher(resolvedRoutes, {
      authorize: options.authorize,
      onError: ({ error, request, executionContext, resolvedRoute }) => present(Effect.gen(function* () {
        // Generated before the event so the logged cause and the client's
        // generic response carry the same id.
        const correlationId = createErrorCorrelationId();
        (yield* integrationValue(lifecycle.emit("error", {
          error,
          request,
          context: executionContext,
          resolvedRoute,
          correlationId,
        })));
        return (
          ((yield* integrationValue(options.onError?.({
            error,
            request,
            executionContext,
            resolvedRoute,
            correlationId,
          })))) ?? toDefaultErrorResponse(error, correlationId)
        );
      })),
      resolvePrincipal,
    }) as ZelavisServerDispatchHandler<TService>;
    const dispatch: ZelavisServerDispatchHandler<TService> = (
      request,
      context,
    ) => present(Effect.gen(function* () {
      yield* integration(() => lifecycle.emit("request", { request, context }));
      return yield* integration(() => baseDispatch(request, context)).pipe(
        Effect.tap((result) => integration(() => lifecycle.emit("response", { request, context, result }))),
        Effect.tapError((failure) => integration(() => lifecycle.emit("error", { error: unwrapFailure(failure), request, context }))),
      );
    }));
    const fetch = createZelavisFetchHandler(
      dispatch,
    ) as ZelavisServerFetchHandler<TService>;
    const plain = createZelavisPlainHandler(
      dispatch,
    ) as ZelavisServerPlainHandler<TService>;
    let closePromise: Promise<void> | undefined;

    yield* integration(() => lifecycle.emit("start", {
      services: serviceMap,
      endpointGroups: endpointGroupMap,
      routes: resolvedRoutes,
      compatibilityDate,
    }));

    return {
      services: serviceMap,
      endpointGroups: endpointGroupMap,
      routes: resolvedRoutes,
      compatibilityDate,
      hooks: lifecycle,
      dispatch,
      fetch,
      plain,
      close() {
        closePromise ??= runFinalizers([
          () => lifecycle.emit("close", { compatibilityDate }),
          ...[...cleanups].reverse(),
        ]);
        return closePromise;
      },
    };
  }).pipe(Effect.catchCause((cause) => Effect.gen(function* () {
    const error = unwrapFailure(Cause.squash(cause));
    const cleanup = yield* integration(() => runFinalizers([...cleanups].reverse())).pipe(
      Effect.as(undefined),
      Effect.catch((failure) => Effect.succeed({ error: unwrapFailure(failure) })),
    );
    if (cleanup) {
      throw new AggregateError(
        [error, cleanup.error],
        "Zelavis server startup and plugin cleanup both failed.",
      );
    }
    throw error;
  }))));
}
