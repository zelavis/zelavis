import type { DatabaseProjectionDefinition, DatabaseProjectionRebuildInput, DatabaseProjectionRebuildResult, DatabaseProjectionsApi, DatabaseProjectionSummary } from "../contracts/api.js";
export declare const BUILTIN_DOCUMENT_PROJECTION_NAME = "documents";
export declare function createBuiltinDocumentProjectionDefinition(): DatabaseProjectionDefinition;
export declare class ProjectionService implements DatabaseProjectionsApi {
    private readonly builtins;
    private readonly registered;
    constructor(builtins?: readonly DatabaseProjectionDefinition[]);
    register(definition: DatabaseProjectionDefinition): Promise<void>;
    list(): Promise<DatabaseProjectionSummary[]>;
    rebuild(input?: DatabaseProjectionRebuildInput): Promise<DatabaseProjectionRebuildResult>;
}
