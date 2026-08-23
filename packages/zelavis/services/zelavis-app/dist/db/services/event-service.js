import { validateDatabaseCollectionName } from "../contracts/documents.js";
function withTenantId(input, defaultTenantId) {
    return {
        ...input,
        tenantId: input.tenantId ?? defaultTenantId,
    };
}
export class EventService {
    driver;
    defaultTenantId;
    defaultNodeId;
    constructor(driver, defaultTenantId, defaultNodeId) {
        this.driver = driver;
        this.defaultTenantId = defaultTenantId;
        this.defaultNodeId = defaultNodeId;
    }
    append(input) {
        validateDatabaseCollectionName(input.collection);
        return this.driver.append({
            ...withTenantId(input, this.defaultTenantId),
            nodeId: input.nodeId ?? this.defaultNodeId,
        });
    }
    read(input = {}) {
        return this.driver.read(withTenantId(input, this.defaultTenantId));
    }
}
