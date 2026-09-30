import {
  identityEndpointGroup,
  createDatabaseAuthRepositories,
  createOAuthProviderRuntime,
  createPasswordProvider,
  PASSWORD_PROVIDER,
  type IdentityMethodPlugin,
  type IdentityServiceOptions,
} from "./identity/index.js";
import type { DatabaseRuntimeApi } from "../db/index.js";
import type { ZelavisServiceRegistryEntry, ZelavisServiceSetupContext } from "../service.js";

function createProjectAuthSettingsStore(database: DatabaseRuntimeApi) {
  const tenant = database.forTenant("service:zelavis-auth-settings");
  const documents = tenant?.documents;
  if (!documents) {
    return Object.freeze({
      async get(_key: string) { return undefined; },
      async set(_key: string, _value: any) {
        throw new Error("Project Auth provider settings require the document database API.");
      },
      async delete(_key: string) { return false; },
      async list() { return []; },
    });
  }
  const collection = "auth_provider_settings";
  let ready: Promise<void> | undefined;
  const ensure = () => ready ??= (async () => {
    if (!(await documents.collectionExists(collection))) {
      await documents.createCollection({
        name: collection,
        surface: "database",
        metadata: { owner: "zelavis/app/identity", purpose: "provider-settings" },
      });
    }
  })();
  return Object.freeze({
    async get(key: string) {
      await ensure();
      return (await documents.findById({ collection, id: key }))?.data.value;
    },
    async set(key: string, value: any) {
      await ensure();
      const current = await documents.findById({ collection, id: key });
      if (current) {
        await documents.update({
          collection,
          id: key,
          data: { value },
          mode: "replace",
          expectedVersion: current.version,
        });
      } else {
        await documents.insert({ collection, id: key, data: { value } });
      }
    },
    async delete(key: string) {
      await ensure();
      return documents.delete({ collection, id: key });
    },
    async list() {
      await ensure();
      return (await documents.findMany({ collection })).map((document) => ({
        key: document.id,
        value: document.data.value,
      }));
    },
  });
}

export function isDatabaseRuntimeApi(value: unknown): value is DatabaseRuntimeApi {
  return Boolean(
    value &&
      typeof value === "object" &&
      "forTenant" in value &&
      "topology" in value,
  );
}

export interface ProjectIdentityInput {
  /** The Project's own logical database: accounts and sessions live in it. */
  readonly database: DatabaseRuntimeApi;
  readonly registry: readonly Readonly<ZelavisServiceRegistryEntry<ZelavisServiceSetupContext>>[];
  /** Installed credential providers discovered by capability. */
  readonly methods: readonly IdentityMethodPlugin[];
  readonly projectId?: string;
  readonly options?: IdentityServiceOptions;
}

/**
 * Identity for a Project runtime.
 *
 * Same subsystem as the Platform's, composed by the runtime rather than by a
 * package: only where its accounts live differs. A Platform keeps them in the
 * System Store; a Project keeps them in its own database, so they travel with
 * the Project and are never visible to another.
 */
export async function createProjectIdentityEndpointGroup(input: ProjectIdentityInput) {
  const { database } = input;
  const authOptions = input.options ?? {};
  const settingsStore = createProjectAuthSettingsStore(database);
  const oauth = createOAuthProviderRuntime(authOptions.oauth ?? {});
  const password: IdentityMethodPlugin = {
    name: PASSWORD_PROVIDER,
    register(api) {
      api.authentication.registerProvider(
        createPasswordProvider(authOptions.password ?? {}),
      );
    },
  };
  const inheritedMethodContext = authOptions.authOptions?.methodContext;

  return identityEndpointGroup({
    ...authOptions,
    registration: authOptions.registration ?? true,
    authOptions: {
      ...(authOptions.authOptions ?? {}),
      projectId: input.projectId ?? authOptions.authOptions?.projectId,
      repositories: {
        ...createDatabaseAuthRepositories(database),
        ...(authOptions.authOptions?.repositories ?? {}),
      },
      methodContext(method) {
        const inherited = inheritedMethodContext?.(method);
        return {
          ...(inherited ?? {}),
          registry: input.registry ?? inherited?.registry ?? [],
          ...(method === oauth.method ? { store: settingsStore } : {}),
        };
      },
    },
    methods: [
      password,
      oauth.method,
      ...(authOptions.methods ?? []),
      ...input.methods,
    ],
    definition: {
      ...(authOptions.definition ?? {}),
      oauthConnections: oauth.connections,
    },
  });
}
