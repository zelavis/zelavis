import { authService, } from "./auth/index.js";
import { createDatabase, defineDatabaseService, } from "./db/index.js";
import { defineService, } from "@zelavis/server";
import { workloadsService, } from "./workloads/index.js";
function isDatabaseApi(value) {
    return Boolean(value &&
        typeof value === "object" &&
        "documents" in value &&
        "driver" in value &&
        "capabilities" in value);
}
function collectAuthProviderServices(children) {
    return Object.freeze(children
        .filter((service) => typeof service.setup === "function")
        .map((service) => service));
}
async function resolveDatabase(context, option) {
    if (isDatabaseApi(option)) {
        return option;
    }
    if (isDatabaseApi(context.core.database)) {
        return context.core.database;
    }
    return createDatabase(option);
}
export function zelavisAppService(options = {}) {
    return defineService({
        name: "@zelavis/app",
        version: "1.0.1-alpha.2",
        kind: "app",
        capabilities: ["app:project", "dashboard:menu", "api:routes"],
        service: Object.freeze({}),
        marketplace: {
            title: "Zelavis App",
            summary: "The official Zelavis-native project backend with database, auth, and workloads.",
            categories: ["apps", "official"],
            tags: ["backend", "database", "auth", "workloads"],
        },
        menu: {
            title: "Overview",
            path: "/",
            pageLabel: "Project",
            sectionLabel: "Overview",
            surface: "root",
            access: {
                permissions: ["project.view"],
                scope: { type: "project", projectIdParam: "projectId" },
            },
        },
        async setup(context) {
            const runtimeServices = [];
            const database = await resolveDatabase(context, options.database);
            runtimeServices.push(defineDatabaseService(database));
            if (options.auth !== false) {
                const authOptions = options.auth === undefined ? {} : options.auth;
                const childServices = context.children.map((service) => service.name);
                runtimeServices.push(authService({
                    ...authOptions,
                    services: [
                        ...(authOptions.services ?? []),
                        ...collectAuthProviderServices(context.children),
                    ],
                    childServices: [
                        ...(authOptions.childServices ?? []),
                        ...childServices,
                    ],
                }));
            }
            if (options.workloads !== false) {
                runtimeServices.push(workloadsService(options.workloads === undefined ? {} : options.workloads));
            }
            return { runtimeServices };
        },
    });
}
export const zelavisApp = zelavisAppService();
export default zelavisApp;
