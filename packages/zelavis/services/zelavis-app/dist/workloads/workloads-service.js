const workloadTypes = ["function", "job", "schedule", "webhook"];
const workloadPluralByType = {
    function: "functions",
    job: "jobs",
    schedule: "schedules",
    webhook: "webhooks",
};
const defaultFunctionCode = `export default async function handler(ctx) {
  return new Response("Hello from Zelavis Workloads");
}
`;
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function now() {
    return new Date().toISOString();
}
function createId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 8)}`;
}
function slugifyName(value) {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
function readBodyObject(body) {
    if (!isRecord(body)) {
        throw new TypeError("Request body must be a JSON object.");
    }
    return body;
}
function readString(body, key, fallback) {
    const value = body[key];
    if (value == null) {
        return fallback;
    }
    if (typeof value !== "string") {
        throw new TypeError(`${key} must be a string.`);
    }
    return value;
}
function readBoolean(body, key, fallback) {
    const value = body[key];
    if (value == null) {
        return fallback;
    }
    if (typeof value !== "boolean") {
        throw new TypeError(`${key} must be a boolean.`);
    }
    return value;
}
function readWorkloadType(value) {
    if (typeof value === "string" &&
        workloadTypes.includes(value)) {
        return value;
    }
    throw new TypeError("type must be function, job, schedule, or webhook.");
}
function jsonError(error, status = 400) {
    return {
        status,
        body: {
            error: error instanceof Error ? error.message : String(error),
        },
    };
}
function normalizeRoutePath(path) {
    if (!path) {
        return "/";
    }
    const trimmed = path.trim();
    if (!trimmed || trimmed === "/") {
        return "/";
    }
    return `/${trimmed.replace(/^\/+/, "").replace(/\/+$/, "")}`;
}
function createModuleDataUrl(workload) {
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(workload.code)}#${encodeURIComponent(`${workload.id}:${workload.updatedAt}`)}`;
}
function toHeaderRecord(headers) {
    const result = {};
    for (const [key, value] of headers.entries()) {
        result[key] = value;
    }
    return result;
}
async function normalizeExecutionValue(value) {
    if (value instanceof Response) {
        return {
            status: value.ok ? "completed" : "failed",
            responseStatus: value.status,
            headers: toHeaderRecord(value.headers),
            output: await value.text(),
        };
    }
    if (value === undefined) {
        return {
            status: "completed",
            output: "",
        };
    }
    if (value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean") {
        return {
            status: "completed",
            output: String(value ?? ""),
        };
    }
    return {
        status: "completed",
        headers: {
            "content-type": "application/json; charset=utf-8",
        },
        output: JSON.stringify(value),
    };
}
async function executeTrustedJavaScriptWorkload(workload, request) {
    if (workload.type !== "function") {
        throw new TypeError("Only function workloads can be run by the JavaScript runner.");
    }
    const module = (await import(createModuleDataUrl(workload)));
    const handler = module.default ?? module.handler;
    if (typeof handler !== "function") {
        throw new TypeError("Function workloads must export a default function or named handler function.");
    }
    return normalizeExecutionValue(await handler({
        env: {},
        projectId: workload.projectId,
        request,
        route: workload.route,
        workload,
    }));
}
function createSeedWorkloads() {
    const timestamp = now();
    return [
        {
            id: "fn_hello_world",
            projectId: "default",
            type: "function",
            name: "hello-world",
            route: "/api/hello",
            code: defaultFunctionCode,
            enabled: true,
            createdAt: timestamp,
            updatedAt: timestamp,
        },
    ];
}
export function createMemoryWorkloadsStore(seed = createSeedWorkloads()) {
    const workloads = new Map(seed.map((workload) => [workload.id, workload]));
    const runLogs = [];
    return {
        list(filter = {}) {
            return [...workloads.values()]
                .filter((workload) => filter.projectId ? workload.projectId === filter.projectId : true)
                .filter((workload) => (filter.type ? workload.type === filter.type : true))
                .sort((left, right) => left.name.localeCompare(right.name));
        },
        read(id) {
            return workloads.get(id);
        },
        save(workload) {
            workloads.set(workload.id, workload);
            return workload;
        },
        logs(filter = {}) {
            return runLogs
                .filter((log) => filter.projectId ? log.projectId === filter.projectId : true)
                .filter((log) => filter.workloadId ? log.workloadId === filter.workloadId : true)
                .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        },
        appendLog(log) {
            runLogs.unshift(log);
            return log;
        },
    };
}
function readProjectId(query) {
    return query.get("projectId") || "default";
}
function readTypeFromQuery(query) {
    const type = query.get("type");
    return type ? readWorkloadType(type) : undefined;
}
function readTypeFromPlural(value) {
    if (value === "functions") {
        return "function";
    }
    if (value === "jobs") {
        return "job";
    }
    if (value === "schedules") {
        return "schedule";
    }
    if (value === "webhooks") {
        return "webhook";
    }
    throw new TypeError("Unknown workload menu section.");
}
async function createWorkload(store, body) {
    const input = readBodyObject(body);
    const type = readWorkloadType(input.type);
    const name = slugifyName(readString(input, "name", "") ?? "");
    if (!name) {
        throw new TypeError("name is required.");
    }
    const timestamp = now();
    const workload = {
        id: createId(type === "function" ? "fn" : type),
        projectId: slugifyName(readString(input, "projectId", "default") ?? "default"),
        type,
        name,
        code: readString(input, "code", defaultFunctionCode) ?? defaultFunctionCode,
        route: readString(input, "route"),
        schedule: readString(input, "schedule"),
        enabled: readBoolean(input, "enabled", true),
        createdAt: timestamp,
        updatedAt: timestamp,
    };
    return store.save(workload);
}
async function updateWorkload(store, id, body) {
    const existing = await store.read(id);
    if (!existing) {
        throw new TypeError("Workload not found.");
    }
    const input = readBodyObject(body);
    const next = {
        ...existing,
        name: slugifyName(readString(input, "name", existing.name) ?? existing.name),
        code: readString(input, "code", existing.code) ?? existing.code,
        route: readString(input, "route", existing.route),
        schedule: readString(input, "schedule", existing.schedule),
        enabled: readBoolean(input, "enabled", existing.enabled),
        updatedAt: now(),
    };
    return store.save(next);
}
async function runWorkload(store, workload) {
    const timestamp = now();
    const request = new Request(`http://zelavis.local${normalizeRoutePath(workload.route)}`);
    try {
        const result = await executeTrustedJavaScriptWorkload(workload, request);
        const log = {
            id: createId("run"),
            workloadId: workload.id,
            projectId: workload.projectId,
            status: result.status,
            responseStatus: result.responseStatus,
            output: result.output,
            createdAt: timestamp,
        };
        return store.appendLog(log);
    }
    catch (error) {
        const log = {
            id: createId("run"),
            workloadId: workload.id,
            projectId: workload.projectId,
            status: "failed",
            output: error instanceof Error ? error.message : String(error),
            createdAt: timestamp,
        };
        return store.appendLog(log);
    }
}
async function findHttpFunction(store, projectId, path) {
    const normalizedPath = normalizeRoutePath(path);
    const workloads = await store.list({
        projectId,
        type: "function",
    });
    return workloads.find((workload) => workload.enabled && normalizeRoutePath(workload.route) === normalizedPath);
}
async function runHttpFunction(store, workload, request) {
    const timestamp = now();
    try {
        const result = await executeTrustedJavaScriptWorkload(workload, request);
        await store.appendLog({
            id: createId("run"),
            workloadId: workload.id,
            projectId: workload.projectId,
            status: result.status,
            responseStatus: result.responseStatus,
            output: result.output,
            createdAt: timestamp,
        });
        return {
            status: result.responseStatus ?? (result.status === "failed" ? 500 : 200),
            headers: result.headers,
            body: result.output,
        };
    }
    catch (error) {
        const output = error instanceof Error ? error.message : String(error);
        await store.appendLog({
            id: createId("run"),
            workloadId: workload.id,
            projectId: workload.projectId,
            status: "failed",
            output,
            createdAt: timestamp,
        });
        return {
            status: 500,
            body: {
                error: output,
            },
        };
    }
}
function createHttpFunctionRoute(store, method) {
    return {
        id: `workloads.http.${method.toLowerCase()}`,
        method,
        path: "/http/:projectId/*path",
        handler: async ({ params, request, }) => {
            try {
                const projectId = params.projectId || "default";
                const requestedPath = normalizeRoutePath(params.path);
                const workload = await findHttpFunction(store, projectId, requestedPath);
                if (!workload) {
                    return {
                        status: 404,
                        body: {
                            error: "Function route not found.",
                        },
                    };
                }
                return runHttpFunction(store, workload, request);
            }
            catch (error) {
                return jsonError(error);
            }
        },
    };
}
function route(handler) {
    return async (context) => {
        try {
            return {
                status: 200,
                body: await handler(context),
            };
        }
        catch (error) {
            return jsonError(error);
        }
    };
}
export function workloadsService(options = {}) {
    const store = options.store ?? createMemoryWorkloadsStore();
    const service = { store };
    return {
        name: "@zelavis/workloads",
        basePath: "/workloads",
        service,
        menu: {
            title: "Workloads",
            path: "/workloads",
            panelLabel: "Workloads",
            surface: "core",
            items: [
                {
                    title: "Functions",
                    path: "/workloads/functions",
                    panelLabel: "Functions",
                    items: [
                        {
                            title: "Add Function",
                            path: "/workloads/new",
                            pageLabel: "Workloads",
                            fixed: true,
                            fixedOrder: 1,
                        },
                    ],
                    dynamicItems: {
                        path: "/workloads/menu/functions",
                        emptyTitle: "No functions yet",
                        emptyPath: "/workloads/functions",
                    },
                },
                {
                    title: "Jobs",
                    path: "/workloads/jobs",
                    panelLabel: "Jobs",
                    dynamicItems: {
                        path: "/workloads/menu/jobs",
                        emptyTitle: "No jobs yet",
                        emptyPath: "/workloads/jobs",
                    },
                },
                {
                    title: "Schedules",
                    path: "/workloads/schedules",
                    panelLabel: "Schedules",
                    dynamicItems: {
                        path: "/workloads/menu/schedules",
                        emptyTitle: "No schedules yet",
                        emptyPath: "/workloads/schedules",
                    },
                },
                {
                    title: "Webhooks",
                    path: "/workloads/webhooks",
                    panelLabel: "Webhooks",
                    dynamicItems: {
                        path: "/workloads/menu/webhooks",
                        emptyTitle: "No webhooks yet",
                        emptyPath: "/workloads/webhooks",
                    },
                },
                { title: "Logs", path: "/workloads/logs", pageLabel: "Workloads" },
                { title: "Settings", path: "/workloads/settings", pageLabel: "Workloads" },
            ],
        },
        api: {
            v1: [
                {
                    id: "workloads.health",
                    method: "GET",
                    path: "/health",
                    handler: route(async () => ({ status: "ready" })),
                },
                {
                    id: "workloads.menu",
                    method: "GET",
                    path: "/menu/:section",
                    handler: route(async ({ params, query }) => {
                        const type = readTypeFromPlural(params.section);
                        const projectId = readProjectId(query);
                        const workloads = await store.list({ projectId, type });
                        return {
                            items: workloads.map((workload) => ({
                                title: workload.name,
                                path: `/workloads/${workloadPluralByType[workload.type]}/${workload.id}`,
                                pageLabel: "Workloads",
                            })),
                        };
                    }),
                },
                {
                    id: "workloads.list",
                    method: "GET",
                    path: "/",
                    handler: route(async ({ query }) => ({
                        workloads: await store.list({
                            projectId: readProjectId(query),
                            type: readTypeFromQuery(query),
                        }),
                    })),
                },
                {
                    id: "workloads.create",
                    method: "POST",
                    path: "/",
                    handler: async ({ body }) => {
                        try {
                            return {
                                status: 201,
                                body: await createWorkload(store, body),
                            };
                        }
                        catch (error) {
                            return jsonError(error);
                        }
                    },
                },
                {
                    id: "workloads.read",
                    method: "GET",
                    path: "/:id",
                    handler: route(async ({ params }) => {
                        const workload = await store.read(params.id);
                        if (!workload) {
                            throw new TypeError("Workload not found.");
                        }
                        return workload;
                    }),
                },
                {
                    id: "workloads.update",
                    method: "PUT",
                    path: "/:id",
                    handler: route(async ({ params, body }) => updateWorkload(store, params.id, body)),
                },
                {
                    id: "workloads.run",
                    method: "POST",
                    path: "/:id/run",
                    handler: route(async ({ params }) => {
                        const workload = await store.read(params.id);
                        if (!workload) {
                            throw new TypeError("Workload not found.");
                        }
                        return runWorkload(store, workload);
                    }),
                },
                ...["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) => createHttpFunctionRoute(store, method)),
                {
                    id: "workloads.logs",
                    method: "GET",
                    path: "/logs",
                    handler: route(async ({ query }) => ({
                        logs: await store.logs({
                            projectId: readProjectId(query),
                            workloadId: query.get("workloadId") || undefined,
                        }),
                    })),
                },
            ],
        },
    };
}
