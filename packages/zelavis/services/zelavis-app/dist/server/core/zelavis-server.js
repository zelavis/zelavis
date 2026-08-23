import { createZelavisDispatcher, createZelavisFetchHandler, createZelavisPlainHandler, } from "./request-dispatcher.js";
import { resolveMountedEndpoints } from "./resolve-endpoints.js";
async function resolveServiceInput(input) {
    const service = await input;
    if (!service.services?.length) {
        return service;
    }
    const services = await Promise.all(service.services.map((child) => resolveServiceInput(child)));
    return {
        ...service,
        services,
    };
}
function toServiceMap(services) {
    const result = {};
    for (const service of services) {
        result[service.name] = service;
    }
    return result;
}
export async function zelavisServer(options) {
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
    });
    const fetch = createZelavisFetchHandler(dispatch);
    const plain = createZelavisPlainHandler(dispatch);
    return {
        services: toServiceMap(services),
        routes: resolvedRoutes,
        dispatch,
        fetch,
        plain,
    };
}
