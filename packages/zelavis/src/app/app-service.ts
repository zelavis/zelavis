import { Effect } from "effect";
import { present, integration, integrationValue } from "../core/runtime/effect-boundary.js";
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
      get(_key: string) {
    return present(integration(() => undefined));
  },
      set(_key: string, _value: any) {
    return present(Effect.gen(function* () {
        throw new Error("Project Auth provider settings require the document database API.");
      }));
  },
      delete(_key: string) {
    return present(integration(() => false));
  },
      list() {
    return present(integration(() => []));
  },
    });
  }
  const collection = "auth_provider_settings";
  let ready: Promise<void> | undefined;
  const ensure = () => ready ??= (() => present(Effect.gen(function* () {
    if (!((yield* integrationValue(documents.collectionExists(collection))))) {
      (yield* integrationValue(documents.createCollection({
        name: collection,
        surface: "database",
        metadata: { owner: "zelavis/app/identity", purpose: "provider-settings" },
      })));
    }
  })))();
  return Object.freeze({
    get(key: string) {
    return present(Effect.gen(function* () {
      (yield* integrationValue(ensure()));
      return ((yield* integrationValue(documents.findById({ collection, id: key }))))?.data.value;
    }));
  },
    set(key: string, value: any) {
    return present(Effect.gen(function* () {
      (yield* integrationValue(ensure()));
      const current = (yield* integrationValue(documents.findById({ collection, id: key })));
      if (current) {
        (yield* integrationValue(documents.update({
          collection,
          id: key,
          data: { value },
          mode: "replace",
          expectedVersion: current.version,
        })));
      } else {
        (yield* integrationValue(documents.insert({ collection, id: key, data: { value } })));
      }
    }));
  },
    delete(key: string) {
    return present(Effect.gen(function* () {
      (yield* integrationValue(ensure()));
      return (yield* integrationValue(documents.delete({ collection, id: key })));
    }));
  },
    list() {
    return present(Effect.gen(function* () {
      (yield* integrationValue(ensure()));
      return (yield* integrationValue(((yield* integrationValue(documents.findMany({ collection })))).map((document) => ({
        key: document.id,
        value: document.data.value,
      }))));
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
export function createProjectIdentityEndpointGroup(input: ProjectIdentityInput) {
    return present(Effect.gen(function* () {
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

  return (yield* integrationValue(identityEndpointGroup({
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
  })));
}));
  }
