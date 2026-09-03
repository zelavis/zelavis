import type { ZelavisResolvedRoute } from "./contracts.js";

export interface OpenApiGeneratorOptions {
  title?: string;
  version?: string;
  description?: string;
  servers?: { url: string; description?: string }[];
  components?: Record<string, unknown>;
}

export function generateOpenApiSpec(
  routes: readonly ZelavisResolvedRoute[],
  options?: OpenApiGeneratorOptions,
) {
  const spec: any = {
    openapi: "3.1.0",
    info: {
      title: options?.title ?? "Zelavis API",
      version: options?.version ?? "1.0.0",
    },
    paths: {},
  };

  if (options?.description) {
    spec.info.description = options.description;
  }

  if (options?.servers) {
    spec.servers = options.servers;
  }

  if (options?.components) {
    spec.components = options.components;
  }

  // Every mounted route, not only the annotated ones. Filtering to routes
  // carrying a `spec` silently omitted whatever had not been annotated yet —
  // which was most of the Platform's own control plane, so the document
  // described a fraction of the API while looking complete.
  for (const resolvedRoute of routes) {
    const routeSpec = resolvedRoute.route.spec;

    // `:param` and `*rest` are this router's syntax; OpenAPI writes both as
    // `{name}`.
    const openApiPath = resolvedRoute.fullPath
      .replace(/:([a-zA-Z0-9_]+)/g, "{$1}")
      .replace(/\*([a-zA-Z0-9_]+)/g, "{$1}");

    if (!spec.paths[openApiPath]) {
      spec.paths[openApiPath] = {};
    }

    const method = resolvedRoute.route.method.toLowerCase();

    const operation: any = {
      // A route id is stable and unique, so it stands in for an operation id
      // nobody has written yet rather than leaving the operation unnamed.
      operationId: routeSpec?.operationId ?? resolvedRoute.route.id,
    };

    if (routeSpec?.summary) operation.summary = routeSpec.summary;
    if (routeSpec?.description) operation.description = routeSpec.description;
    if (routeSpec?.tags) operation.tags = routeSpec.tags;
    if (!routeSpec) {
      // Marked rather than passed off as documented: a consumer can see which
      // endpoints exist but have not described their inputs and responses.
      operation.tags = [resolvedRoute.service.name];
      operation["x-zelavis-undocumented"] = true;
    }

    const parameters: any[] = [];

    // Extract path parameters from the path pattern and merge with spec.pathParams
    const pathParamsMatch =
      resolvedRoute.fullPath.match(/[:*]([a-zA-Z0-9_]+)/g) ?? [];
    for (const match of pathParamsMatch) {
      const paramName = match.substring(1);
      const paramSpec = routeSpec?.pathParams?.[paramName];
      const param: Record<string, unknown> = {
        name: paramName,
        in: "path",
        required: true,
        schema: { type: paramSpec?.type ?? "string" },
      };
      if (paramSpec?.enum) {
        (param.schema as Record<string, unknown>).enum = paramSpec.enum;
      }
      if (paramSpec?.description) {
        param.description = paramSpec.description;
      }
      parameters.push(param);
    }

    // Add query parameters from spec.queryParams
    if (routeSpec?.queryParams) {
      for (const [name, queryParam] of Object.entries(routeSpec.queryParams)) {
        const param: Record<string, unknown> = {
          name,
          in: "query",
          schema: { type: queryParam.type },
        };
        if (queryParam.required) param.required = true;
        if (queryParam.enum) {
          (param.schema as Record<string, unknown>).enum = queryParam.enum;
        }
        if (queryParam.description) param.description = queryParam.description;
        parameters.push(param);
      }
    }

    if (parameters.length > 0) {
      operation.parameters = parameters;
    }

    // Add request body from spec.requestBody
    if (routeSpec?.requestBody) {
      const requestBody: Record<string, unknown> = {
        content: {
          "application/json": {
            schema: routeSpec.requestBody.schema,
          },
        },
      };
      if (routeSpec.requestBody.required) requestBody.required = true;
      if (routeSpec.requestBody.description) requestBody.description = routeSpec.requestBody.description;
      operation.requestBody = requestBody;
    }

    // Add responses from spec.responses (default 200 if none specified)
    operation.responses = {};
    if (routeSpec?.responses) {
      for (const [statusCode, responseSpec] of Object.entries(routeSpec.responses)) {
        operation.responses[statusCode] = {
          description: responseSpec.description,
        };
        if (responseSpec.schema) {
          operation.responses[statusCode].content = {
            "application/json": {
              schema: responseSpec.schema,
            },
          };
        }
      }
    } else {
      operation.responses["200"] = {
        description: "Success",
      };
    }

    spec.paths[openApiPath][method] = operation;
  }

  return spec;
}
