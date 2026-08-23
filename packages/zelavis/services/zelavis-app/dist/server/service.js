export const ZELAVIS_SERVICE_V1 = "ZELAVIS_SERVICE_V1";
const scopedServiceNamePattern = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const menuFixedActionScopes = [
    "local",
    "inherit",
    "replace",
    "clear",
];
function isBundleRelativeFilePath(path) {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return (!normalized.startsWith("/") &&
        segments.length > 0 &&
        segments.every((segment) => segment !== "." && segment !== ".."));
}
function freezeMenu(menu) {
    return Object.freeze({
        ...menu,
        page: menu.page
            ? Object.freeze({
                ...menu.page,
            })
            : menu.page,
        items: menu.items?.map(freezeMenu),
    });
}
function validateServiceMenu(menu, path = menu.title) {
    // `surface` is allowed in the definition — the activation layer enforces
    // extension-only scoping for runtime-installed services at registration time,
    // not here. System services registered statically may use any surface.
    validateOptionalBoolean(menu.fixed, `Service menu fixed flag for "${path}"`);
    validateOptionalNumber(menu.fixedOrder, `Service menu fixedOrder for "${path}"`);
    validateOptionalMenuFixedActionScope(menu.fixedActionScope, `Service menu fixedActionScope for "${path}"`);
    if ("page" in menu && menu.page !== undefined) {
        if (!menu.page || typeof menu.page !== "object") {
            throw new TypeError(`Service menu page metadata for "${path}" must be an object.`);
        }
        if (!menu.page.id || typeof menu.page.id !== "string") {
            throw new TypeError(`Service menu page metadata for "${path}" must include a string id.`);
        }
        if ("file" in menu.page &&
            menu.page.file !== undefined &&
            typeof menu.page.file !== "string") {
            throw new TypeError(`Service menu page metadata for "${path}" file must be a string when provided.`);
        }
        if ("file" in menu.page &&
            typeof menu.page.file === "string" &&
            !isBundleRelativeFilePath(menu.page.file)) {
            throw new TypeError(`Service menu page metadata for "${path}" file must be a bundle-relative path.`);
        }
        if ("bundle" in menu.page &&
            menu.page.bundle !== undefined &&
            typeof menu.page.bundle !== "string") {
            throw new TypeError(`Service menu page metadata for "${path}" bundle must be a string when provided.`);
        }
        if ("title" in menu.page &&
            menu.page.title !== undefined &&
            typeof menu.page.title !== "string") {
            throw new TypeError(`Service menu page metadata for "${path}" title must be a string when provided.`);
        }
        if (!menu.page.file) {
            throw new TypeError(`Service menu page metadata for "${path}" must include a page.file HTML entry.`);
        }
    }
    if ("dynamicItems" in menu && menu.dynamicItems !== undefined) {
        if (!menu.dynamicItems || typeof menu.dynamicItems !== "object") {
            throw new TypeError(`Service menu dynamicItems metadata for "${path}" must be an object.`);
        }
        if (!menu.dynamicItems.path ||
            typeof menu.dynamicItems.path !== "string") {
            throw new TypeError(`Service menu dynamicItems metadata for "${path}" must include a string path.`);
        }
        if ("emptyTitle" in menu.dynamicItems &&
            menu.dynamicItems.emptyTitle !== undefined &&
            typeof menu.dynamicItems.emptyTitle !== "string") {
            throw new TypeError(`Service menu dynamicItems metadata for "${path}" emptyTitle must be a string when provided.`);
        }
        if ("emptyPath" in menu.dynamicItems &&
            menu.dynamicItems.emptyPath !== undefined &&
            typeof menu.dynamicItems.emptyPath !== "string") {
            throw new TypeError(`Service menu dynamicItems metadata for "${path}" emptyPath must be a string when provided.`);
        }
        if ("emptySearch" in menu.dynamicItems &&
            menu.dynamicItems.emptySearch !== undefined &&
            (!menu.dynamicItems.emptySearch ||
                typeof menu.dynamicItems.emptySearch !== "object" ||
                Array.isArray(menu.dynamicItems.emptySearch))) {
            throw new TypeError(`Service menu dynamicItems metadata for "${path}" emptySearch must be an object when provided.`);
        }
        if (menu.dynamicItems.emptySearch) {
            for (const [key, value] of Object.entries(menu.dynamicItems.emptySearch)) {
                if (typeof key !== "string" || (value !== undefined && typeof value !== "string")) {
                    throw new TypeError(`Service menu dynamicItems metadata for "${path}" emptySearch values must be strings when provided.`);
                }
            }
        }
    }
    menu.items?.forEach((item) => validateServiceMenu(item, `${path} > ${item.title}`));
}
function validateOptionalString(value, fieldName) {
    if (value !== undefined && typeof value !== "string") {
        throw new TypeError(`${fieldName} must be a string when provided.`);
    }
}
function validateOptionalBoolean(value, fieldName) {
    if (value !== undefined && typeof value !== "boolean") {
        throw new TypeError(`${fieldName} must be a boolean when provided.`);
    }
}
function validateOptionalNumber(value, fieldName) {
    if (value !== undefined && typeof value !== "number") {
        throw new TypeError(`${fieldName} must be a number when provided.`);
    }
}
function validateOptionalMenuFixedActionScope(value, fieldName) {
    if (value !== undefined &&
        !menuFixedActionScopes.includes(value)) {
        throw new TypeError(`${fieldName} must be "local", "inherit", "replace", or "clear" when provided.`);
    }
}
function validateScopedServiceName(value, fieldName) {
    if (typeof value !== "string" || !scopedServiceNamePattern.test(value)) {
        throw new TypeError(`${fieldName} must be a scoped package-style name such as "@zelavis/auth" or "@acme/search".`);
    }
}
function freezeCatalogCompatibility(compatibility) {
    validateOptionalString(compatibility.zelavis, "Service catalog compatibility zelavis");
    validateOptionalString(compatibility.parentService, "Service catalog compatibility parentService");
    validateOptionalString(compatibility.service, "Service catalog compatibility service");
    return Object.freeze({ ...compatibility });
}
function freezeCatalogLinks(links) {
    validateOptionalString(links.homepage, "Service catalog link homepage");
    validateOptionalString(links.repository, "Service catalog link repository");
    validateOptionalString(links.documentation, "Service catalog link documentation");
    validateOptionalString(links.issues, "Service catalog link issues");
    return Object.freeze({ ...links });
}
function freezeMarketplaceMetadata(marketplace) {
    validateOptionalString(marketplace.title, "Service marketplace title");
    validateOptionalString(marketplace.summary, "Service marketplace summary");
    validateOptionalString(marketplace.description, "Service marketplace description");
    if (marketplace.categories !== undefined &&
        !Array.isArray(marketplace.categories)) {
        throw new TypeError("Service marketplace categories must be an array.");
    }
    if (marketplace.tags !== undefined && !Array.isArray(marketplace.tags)) {
        throw new TypeError("Service marketplace tags must be an array.");
    }
    for (const category of marketplace.categories ?? []) {
        if (!category || typeof category !== "string") {
            throw new TypeError("Service marketplace categories must be strings.");
        }
    }
    for (const tag of marketplace.tags ?? []) {
        if (!tag || typeof tag !== "string") {
            throw new TypeError("Service marketplace tags must be strings.");
        }
    }
    return Object.freeze({
        ...marketplace,
        categories: marketplace.categories
            ? Object.freeze([...marketplace.categories])
            : marketplace.categories,
        tags: marketplace.tags ? Object.freeze([...marketplace.tags]) : marketplace.tags,
    });
}
function freezeChildServices(childServices) {
    if (!Array.isArray(childServices)) {
        throw new TypeError("Service childServices must be provided as an array.");
    }
    const seen = new Set();
    for (const childService of childServices) {
        validateScopedServiceName(childService, "Service childServices entry");
        if (seen.has(childService)) {
            throw new TypeError(`Service childServices must use unique names. Duplicate: ${childService}`);
        }
        seen.add(childService);
    }
    return Object.freeze([...childServices]);
}
function validateServiceApp(app) {
    if (!app || typeof app !== "object") {
        throw new TypeError("Service app metadata must be an object.");
    }
    if ("mount" in app &&
        app.mount !== undefined &&
        typeof app.mount !== "string") {
        throw new TypeError("Service app mount must be a string when provided.");
    }
    if (app.mount !== undefined && !app.mount.startsWith("/")) {
        throw new TypeError("Service app mount must start with a leading slash.");
    }
    if ("domainPolicy" in app && app.domainPolicy !== undefined) {
        if (app.domainPolicy !== "optional" &&
            app.domainPolicy !== "required") {
            throw new TypeError('Service app domainPolicy must be "optional" or "required".');
        }
    }
    if ("bundle" in app &&
        app.bundle !== undefined &&
        typeof app.bundle !== "string") {
        throw new TypeError("Service app bundle must be a string when provided.");
    }
    if ("indexHtml" in app &&
        app.indexHtml !== undefined &&
        typeof app.indexHtml !== "string") {
        throw new TypeError("Service app indexHtml must be a string when provided.");
    }
    if ("mode" in app && app.mode !== undefined) {
        if (app.mode !== "spa" && app.mode !== "mpa") {
            throw new TypeError('Service app mode must be "spa" or "mpa".');
        }
    }
    if ("shell" in app && app.shell !== undefined) {
        if (!app.shell || typeof app.shell !== "object") {
            throw new TypeError("Service app shell must be an object when provided.");
        }
        if (typeof app.shell.render !== "function") {
            throw new TypeError("Service app shell.render must be a function.");
        }
    }
    if ("devUrl" in app &&
        app.devUrl !== undefined &&
        typeof app.devUrl !== "string") {
        throw new TypeError("Service app devUrl must be a string when provided.");
    }
    if ("devUrlExcludePaths" in app && app.devUrlExcludePaths !== undefined) {
        if (!Array.isArray(app.devUrlExcludePaths)) {
            throw new TypeError("Service app devUrlExcludePaths must be an array when provided.");
        }
        for (const path of app.devUrlExcludePaths) {
            if (typeof path !== "string") {
                throw new TypeError("Service app devUrlExcludePaths entries must be strings.");
            }
        }
    }
}
function freezeServiceApp(app) {
    return Object.freeze({
        mount: app.mount,
        domainPolicy: app.domainPolicy,
        bundle: app.bundle,
        indexHtml: app.indexHtml,
        mode: app.mode,
        shell: app.shell ? Object.freeze({ render: app.shell.render }) : app.shell,
        devUrl: app.devUrl,
        devUrlExcludePaths: app.devUrlExcludePaths
            ? Object.freeze([...app.devUrlExcludePaths])
            : app.devUrlExcludePaths,
    });
}
export function isChildServiceAllowed(parent, child) {
    if (child.service.extends !== parent.service.name) {
        return false;
    }
    return parent.service.childServices?.includes(child.service.name) ?? false;
}
export function defineServiceCatalogEntry(entry) {
    if (!entry || typeof entry !== "object") {
        throw new TypeError("A service catalog entry object is required.");
    }
    if (!entry.name || typeof entry.name !== "string") {
        throw new TypeError("A service catalog entry must include a string name.");
    }
    validateScopedServiceName(entry.name, "Service catalog entry name");
    if (!entry.package || typeof entry.package !== "string") {
        throw new TypeError("A service catalog entry must include a string package.");
    }
    if (!entry.publisher || typeof entry.publisher !== "string") {
        throw new TypeError("A service catalog entry must include a string publisher.");
    }
    if (entry.source !== "official" && entry.source !== "community") {
        throw new TypeError('A service catalog entry source must be "official" or "community".');
    }
    if (entry.reviewStatus !== undefined &&
        entry.reviewStatus !== "official" &&
        entry.reviewStatus !== "reviewed" &&
        entry.reviewStatus !== "unreviewed" &&
        entry.reviewStatus !== "blocked") {
        throw new TypeError('A service catalog entry reviewStatus must be "official", "reviewed", "unreviewed", or "blocked".');
    }
    validateOptionalString(entry.title, "Service catalog entry title");
    validateOptionalString(entry.summary, "Service catalog entry summary");
    validateOptionalString(entry.description, "Service catalog entry description");
    validateOptionalString(entry.version, "Service catalog entry version");
    validateOptionalString(entry.license, "Service catalog entry license");
    if (entry.verified !== undefined && typeof entry.verified !== "boolean") {
        throw new TypeError("A service catalog entry verified field must be boolean when provided.");
    }
    if (entry.extends !== undefined) {
        validateScopedServiceName(entry.extends, "Service catalog entry extends");
    }
    if (entry.compatibility !== undefined) {
        if (!entry.compatibility || typeof entry.compatibility !== "object") {
            throw new TypeError("A service catalog entry compatibility field must be an object.");
        }
    }
    if (entry.links !== undefined) {
        if (!entry.links || typeof entry.links !== "object") {
            throw new TypeError("A service catalog entry links field must be an object.");
        }
    }
    if (entry.tags !== undefined && !Array.isArray(entry.tags)) {
        throw new TypeError("A service catalog entry tags field must be an array.");
    }
    for (const tag of entry.tags ?? []) {
        if (!tag || typeof tag !== "string") {
            throw new TypeError("A service catalog entry tags must be strings.");
        }
    }
    return Object.freeze({
        ...entry,
        reviewStatus: entry.reviewStatus ??
            (entry.source === "official" ? "official" : "unreviewed"),
        verified: entry.verified ?? (entry.source === "official"),
        extends: entry.extends,
        compatibility: entry.compatibility
            ? freezeCatalogCompatibility(entry.compatibility)
            : entry.compatibility,
        links: entry.links ? freezeCatalogLinks(entry.links) : entry.links,
        tags: entry.tags ? Object.freeze([...entry.tags]) : entry.tags,
    });
}
export function defineServiceCatalog(entries) {
    if (!Array.isArray(entries)) {
        throw new TypeError("A service catalog must be an array.");
    }
    const seen = new Set();
    return Object.freeze(entries.map((entry) => {
        const normalized = defineServiceCatalogEntry(entry);
        if (seen.has(normalized.name)) {
            throw new TypeError(`Service catalog entries must use unique names. Duplicate: ${normalized.name}`);
        }
        seen.add(normalized.name);
        return normalized;
    }));
}
export function defineService(definition) {
    if (!definition || typeof definition !== "object") {
        throw new TypeError("A service definition object is required.");
    }
    if (!definition.name || typeof definition.name !== "string") {
        throw new TypeError("A service must include a string name.");
    }
    validateScopedServiceName(definition.name, "Service name");
    if ("contractVersion" in definition &&
        definition.contractVersion !== undefined &&
        definition.contractVersion !== ZELAVIS_SERVICE_V1) {
        throw new TypeError(`Unsupported service contract version. Expected ${ZELAVIS_SERVICE_V1}.`);
    }
    if ("version" in definition &&
        definition.version !== undefined &&
        typeof definition.version !== "string") {
        throw new TypeError("A service version must be a string when provided.");
    }
    if ("kind" in definition && definition.kind !== undefined) {
        const allowedKinds = [
            "app",
            "core",
            "plugin",
            "web-app",
            "website",
            "dashboard-extension",
            "provider",
            "template",
        ];
        if (!allowedKinds.includes(definition.kind)) {
            throw new TypeError('Service kind must be "app", "core", "plugin", "web-app", "website", "dashboard-extension", "provider", or "template".');
        }
    }
    if ("capabilities" in definition &&
        definition.capabilities !== undefined) {
        if (!Array.isArray(definition.capabilities)) {
            throw new TypeError("Service capabilities must be provided as an array.");
        }
        for (const capability of definition.capabilities) {
            if (!capability || typeof capability !== "string") {
                throw new TypeError("Service capabilities must be string values.");
            }
        }
    }
    if ("marketplace" in definition && definition.marketplace !== undefined) {
        if (!definition.marketplace || typeof definition.marketplace !== "object") {
            throw new TypeError("Service marketplace metadata must be an object.");
        }
    }
    if (definition.menu !== undefined) {
        if (!definition.menu || typeof definition.menu !== "object") {
            throw new TypeError("Service menu metadata must be an object.");
        }
        if (!definition.menu.title ||
            typeof definition.menu.title !== "string") {
            throw new TypeError("Service menu metadata must include a string title.");
        }
        if ("path" in definition.menu &&
            definition.menu.path !== undefined &&
            typeof definition.menu.path !== "string") {
            throw new TypeError("Service menu metadata path must be a string when provided.");
        }
        if (definition.menu.path === undefined &&
            (!definition.menu.items || definition.menu.items.length === 0)) {
            throw new TypeError("Service menu metadata must include a path or nested items.");
        }
        validateServiceMenu(definition.menu);
    }
    if ("setup" in definition &&
        definition.setup !== undefined &&
        typeof definition.setup !== "function") {
        throw new TypeError("A service setup field must be a function.");
    }
    if ("childServices" in definition && definition.childServices !== undefined) {
        freezeChildServices(definition.childServices);
    }
    if ("runtimeServices" in definition &&
        definition.runtimeServices !== undefined &&
        !Array.isArray(definition.runtimeServices)) {
        throw new TypeError("Service runtimeServices must be provided as an array.");
    }
    if ("extends" in definition && definition.extends !== undefined) {
        validateScopedServiceName(definition.extends, "Service extends");
        if (definition.menu !== undefined) {
            throw new TypeError("Child services cannot declare top-level dashboard menu metadata.");
        }
    }
    if ("app" in definition && definition.app !== undefined) {
        validateServiceApp(definition.app);
    }
    const normalized = {
        name: definition.name,
        basePath: definition.basePath,
        api: definition.api ?? {},
        service: definition.service,
        menu: definition.menu ? freezeMenu(definition.menu) : definition.menu,
        runtimeServices: definition.runtimeServices
            ? Object.freeze([...definition.runtimeServices])
            : definition.runtimeServices,
    };
    return Object.freeze({
        ...normalized,
        contractVersion: ZELAVIS_SERVICE_V1,
        // Default to "extension". The registration path (static vs. uploaded)
        // overrides this — see loadStoredServiceRegistryModules in index.ts.
        scope: definition.scope ?? "extension",
        kind: definition.kind,
        capabilities: definition.capabilities
            ? Object.freeze([...definition.capabilities])
            : definition.capabilities,
        marketplace: definition.marketplace
            ? freezeMarketplaceMetadata(definition.marketplace)
            : definition.marketplace,
        childServices: definition.childServices
            ? freezeChildServices(definition.childServices)
            : definition.childServices,
        version: definition.version,
        app: definition.app ? freezeServiceApp(definition.app) : definition.app,
        extends: definition.extends,
        setup: definition.setup,
    });
}
