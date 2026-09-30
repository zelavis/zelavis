/**
 * Where the Admin Agent's model comes from, resolved on every request.
 *
 * Precedence for a Project's own chats: the Project's own provider, if it has
 * one. For everything else: the environment (operator infrastructure, wins and
 * cannot be changed from the API), then the setting an owner stored through the
 * API, then no model, which falls back to the deterministic local router.
 * Resolving per request means saving or clearing a key takes effect without a
 * restart.
 *
 * A Project's key is only ever used for that Project's threads and is bound to
 * its Project, so it neither answers another Project's chats nor decrypts if the
 * record is copied elsewhere. Chats outside any Project use the installation's.
 *
 * The API key is stored encrypted, never returned (callers only learn that one
 * exists) and never written to a thread, an audit record or an error.
 */
import type { ZelavisAssistantResponder } from "./assistant.js";
import { createLocalAssistantResponder } from "./assistant.js";
import {
  ASSISTANT_PROVIDERS,
  createModelAssistantResponder,
  createProviderModel,
  type AssistantModel,
  type AssistantProviderName,
} from "./assistant-model.js";
import type { AssistantToolbox } from "./assistant-tools.js";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "./edge/acme-crypto.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "./system-store.js";

const NAMESPACE = "assistant-provider";
const PLATFORM_KEY = "config";
const ENV_PROVIDER = "ZELAVIS_ASSISTANT_PROVIDER";
const ENV_KEY = "ZELAVIS_ASSISTANT_API_KEY";
const ENV_MODEL = "ZELAVIS_ASSISTANT_MODEL";

export class AssistantProviderConfigError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
    this.name = "AssistantProviderConfigError";
  }
}

/** Whose provider: the installation's, or one Project's own. */
export interface AssistantProviderScope {
  readonly projectId?: string;
}

export interface AssistantProviderStatus {
  /** `model` when a provider answers, `local-router` when none is configured. */
  readonly mode: "model" | "local-router";
  readonly provider?: AssistantProviderName;
  readonly model?: string;
  /** Whether a key is stored in *this* scope; an inherited one is not reported. */
  readonly hasApiKey: boolean;
  /**
   * Where the answering provider comes from. For a Project, `platform` means it
   * has none of its own and uses the installation's (whose details it is not shown).
   */
  readonly source: "environment" | "stored" | "project" | "platform" | "none";
  readonly updatedAt?: string;
}

interface StoredConfig {
  readonly provider: AssistantProviderName;
  readonly model: string;
  readonly apiKey: EncryptedSecret;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface AssistantProviderConfig {
  status(scope?: AssistantProviderScope): Promise<AssistantProviderStatus>;
  set(
    scope: AssistantProviderScope,
    input: { provider?: unknown; model?: unknown; apiKey?: unknown },
    updatedBy: string,
  ): Promise<AssistantProviderStatus>;
  clear(scope?: AssistantProviderScope): Promise<AssistantProviderStatus>;
  /** Drops a deleted Project's own provider. Not subject to the environment. */
  removeProject(projectId: string): Promise<void>;
  /**
   * The model to answer with now. A Project's own provider is used only for that
   * Project's threads; otherwise the environment, then the installation's stored one.
   */
  resolveModel(projectId?: string): Promise<AssistantModel | undefined>;
}

function readEnv(name: string, env: Record<string, string | undefined>): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function validProvider(value: unknown): AssistantProviderName {
  if (typeof value !== "string" || !(ASSISTANT_PROVIDERS as readonly string[]).includes(value)) {
    throw new AssistantProviderConfigError(`provider must be one of: ${ASSISTANT_PROVIDERS.join(", ")}.`);
  }
  return value as AssistantProviderName;
}

function validModel(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.trim())) {
    throw new AssistantProviderConfigError("model must be a model identifier such as vendor/name.");
  }
  return value.trim();
}

function validApiKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    /[\s\u0000-\u001f]/.test(value)
  ) {
    throw new AssistantProviderConfigError("apiKey must be 8 to 512 characters with no whitespace.");
  }
  return value;
}

export function createAssistantProviderConfig(options: {
  readonly store: ZelavisSystemStore;
  readonly masterSecret: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
}): AssistantProviderConfig {
  const env = options.env ?? (typeof process === "undefined" ? {} : process.env);

  const keyOf = (scope: AssistantProviderScope | undefined) =>
    scope?.projectId ? `project:${scope.projectId}` : PLATFORM_KEY;
  // A stored key is bound to its scope, so a record copied or swapped between
  // Projects (or onto the installation) does not decrypt.
  const secretFor = (scope: AssistantProviderScope | undefined) =>
    `${options.masterSecret}\u0000${keyOf(scope)}`;

  async function stored(scope?: AssistantProviderScope): Promise<StoredConfig | undefined> {
    const record = await options.store.get(NAMESPACE, keyOf(scope));
    const value = record?.value as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const config = value as StoredConfig;
    return (ASSISTANT_PROVIDERS as readonly string[]).includes(config.provider) &&
      typeof config.model === "string" && config.apiKey
      ? config
      : undefined;
  }

  const environment = () => {
    const apiKey = readEnv(ENV_KEY, env);
    const model = readEnv(ENV_MODEL, env);
    if (!apiKey || !model) return undefined;
    const provider = validProvider(readEnv(ENV_PROVIDER, env) ?? "openrouter");
    return { provider, apiKey, model };
  };

  async function platformStatus(): Promise<AssistantProviderStatus> {
    const fromEnv = environment();
    if (fromEnv) {
      return { mode: "model", provider: fromEnv.provider, model: fromEnv.model, hasApiKey: true, source: "environment" };
    }
    const config = await stored();
    if (config) {
      return {
        mode: "model", provider: config.provider, model: config.model,
        hasApiKey: true, source: "stored", updatedAt: config.updatedAt,
      };
    }
    return { mode: "local-router", hasApiKey: false, source: "none" };
  }

  async function status(scope?: AssistantProviderScope): Promise<AssistantProviderStatus> {
    if (!scope?.projectId) return platformStatus();
    const own = await stored(scope);
    if (own) {
      return {
        mode: "model", provider: own.provider, model: own.model,
        hasApiKey: true, source: "project", updatedAt: own.updatedAt,
      };
    }
    // Inherited: only whether an answer would come from a model, never whose.
    const inherited = await platformStatus();
    return { mode: inherited.mode, hasApiKey: false, source: inherited.mode === "model" ? "platform" : "none" };
  }

  function refuseWhileEnvironmentControls(scope: AssistantProviderScope | undefined) {
    // The environment is the operator's setting for the installation; a Project
    // bringing its own key is separate and stays allowed.
    if (!scope?.projectId && environment()) {
      throw new AssistantProviderConfigError(
        `The assistant provider is configured by ${ENV_KEY}; unset it and restart to manage it here.`,
        409,
      );
    }
  }

  function build(provider: AssistantProviderName, apiKey: string, model: string) {
    return createProviderModel(provider, {
      apiKey, model, ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  return {
    status,
    async set(scope, input, updatedBy) {
      refuseWhileEnvironmentControls(scope);
      const provider = validProvider(input.provider ?? "openrouter");
      const model = validModel(input.model);
      const apiKey = validApiKey(input.apiKey);
      const config: StoredConfig = {
        provider,
        model,
        apiKey: encryptSecret(apiKey, secretFor(scope)),
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
      await options.store.set(NAMESPACE, keyOf(scope), config as unknown as ZelavisSystemStoreValue);
      return status(scope);
    },
    async clear(scope) {
      refuseWhileEnvironmentControls(scope);
      await options.store.delete(NAMESPACE, keyOf(scope));
      return status(scope);
    },
    async removeProject(projectId) {
      await options.store.delete(NAMESPACE, keyOf({ projectId }));
    },
    async resolveModel(projectId) {
      if (projectId) {
        const own = await stored({ projectId });
        if (own) {
          return build(own.provider, decryptSecret(own.apiKey, secretFor({ projectId })), own.model);
        }
      }
      const fromEnv = environment();
      if (fromEnv) return build(fromEnv.provider, fromEnv.apiKey, fromEnv.model);
      const config = await stored();
      if (!config) return undefined;
      return build(config.provider, decryptSecret(config.apiKey, secretFor(undefined)), config.model);
    },
  };
}

/**
 * Uses the configured model when there is one and the local router otherwise,
 * deciding per message so a key saved in the dashboard applies immediately, and
 * per thread so a Project's own provider answers only that Project's chats.
 */
export function createConfiguredAssistantResponder(options: {
  readonly provider: AssistantProviderConfig;
  readonly toolbox?: AssistantToolbox;
  readonly system?: string;
}): ZelavisAssistantResponder {
  const local = createLocalAssistantResponder();
  return {
    name: "zelavis-assistant",
    async respond(input) {
      const model = await options.provider.resolveModel(input.thread.projectId);
      if (!model) return { ...(await local.respond(input)), provider: "local-router" };
      return createModelAssistantResponder({
        model,
        ...(options.toolbox ? { toolbox: options.toolbox } : {}),
        ...(options.system ? { system: options.system } : {}),
      }).respond(input);
    },
  };
}

/** Removes a deleted Project's own provider, without needing a running config. */
export async function removeProjectAssistantProvider(
  store: ZelavisSystemStore,
  projectId: string,
): Promise<void> {
  await store.delete(NAMESPACE, `project:${projectId}`);
}
