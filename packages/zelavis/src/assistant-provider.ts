/**
 * Where the Admin Agent's model comes from, resolved on every request.
 *
 * Precedence: the environment (operator infrastructure, wins and cannot be
 * changed from the API), then the setting an owner stored through the API,
 * then no model, which falls back to the deterministic local router. Resolving
 * per request means saving or clearing a key takes effect without a restart.
 *
 * The API key is stored encrypted, never returned (callers only learn that one
 * exists) and never written to a thread, an audit record or an error.
 */
import type { ZelavisAssistantResponder } from "./assistant.js";
import { createLocalAssistantResponder } from "./assistant.js";
import {
  createModelAssistantResponder,
  createOpenRouterModel,
  type AssistantModel,
} from "./assistant-model.js";
import type { AssistantToolbox } from "./assistant-tools.js";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "./edge/acme-crypto.js";
import type { ZelavisSystemStore, ZelavisSystemStoreValue } from "./system-store.js";

const NAMESPACE = "assistant-provider";
const KEY = "config";
const ENV_KEY = "ZELAVIS_ASSISTANT_OPENROUTER_API_KEY";
const ENV_MODEL = "ZELAVIS_ASSISTANT_MODEL";

export class AssistantProviderConfigError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 400) {
    super(message);
    this.name = "AssistantProviderConfigError";
  }
}

export interface AssistantProviderStatus {
  /** `model` when a provider answers, `local-router` when none is configured. */
  readonly mode: "model" | "local-router";
  readonly provider?: "openrouter";
  readonly model?: string;
  readonly hasApiKey: boolean;
  readonly source: "environment" | "stored" | "none";
  readonly updatedAt?: string;
}

interface StoredConfig {
  readonly provider: "openrouter";
  readonly model: string;
  readonly apiKey: EncryptedSecret;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface AssistantProviderConfig {
  status(): Promise<AssistantProviderStatus>;
  set(
    input: { provider?: unknown; model?: unknown; apiKey?: unknown },
    updatedBy: string,
  ): Promise<AssistantProviderStatus>;
  clear(): Promise<AssistantProviderStatus>;
  /** The model to answer with now, if any. */
  resolveModel(): Promise<AssistantModel | undefined>;
}

function readEnv(name: string, env: Record<string, string | undefined>): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
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

  async function stored(): Promise<StoredConfig | undefined> {
    const record = await options.store.get(NAMESPACE, KEY);
    const value = record?.value as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const config = value as StoredConfig;
    return config.provider === "openrouter" && typeof config.model === "string" && config.apiKey
      ? config
      : undefined;
  }

  const environment = () => {
    const apiKey = readEnv(ENV_KEY, env);
    const model = readEnv(ENV_MODEL, env);
    return apiKey && model ? { apiKey, model } : undefined;
  };

  async function status(): Promise<AssistantProviderStatus> {
    const fromEnv = environment();
    if (fromEnv) {
      return { mode: "model", provider: "openrouter", model: fromEnv.model, hasApiKey: true, source: "environment" };
    }
    const config = await stored();
    if (config) {
      return {
        mode: "model", provider: "openrouter", model: config.model,
        hasApiKey: true, source: "stored", updatedAt: config.updatedAt,
      };
    }
    return { mode: "local-router", hasApiKey: false, source: "none" };
  }

  function refuseWhileEnvironmentControls() {
    if (environment()) {
      throw new AssistantProviderConfigError(
        `The assistant provider is configured by ${ENV_KEY}; unset it and restart to manage it here.`,
        409,
      );
    }
  }

  return {
    status,
    async set(input, updatedBy) {
      refuseWhileEnvironmentControls();
      if (input.provider !== undefined && input.provider !== "openrouter") {
        throw new AssistantProviderConfigError('provider must be "openrouter".');
      }
      const model = validModel(input.model);
      const apiKey = validApiKey(input.apiKey);
      const config: StoredConfig = {
        provider: "openrouter",
        model,
        apiKey: encryptSecret(apiKey, options.masterSecret),
        updatedAt: new Date().toISOString(),
        updatedBy,
      };
      await options.store.set(NAMESPACE, KEY, config as unknown as ZelavisSystemStoreValue);
      return status();
    },
    async clear() {
      refuseWhileEnvironmentControls();
      await options.store.delete(NAMESPACE, KEY);
      return status();
    },
    async resolveModel() {
      const fromEnv = environment();
      if (fromEnv) {
        return createOpenRouterModel({ ...fromEnv, ...(options.fetch ? { fetch: options.fetch } : {}) });
      }
      const config = await stored();
      if (!config) return undefined;
      return createOpenRouterModel({
        apiKey: decryptSecret(config.apiKey, options.masterSecret),
        model: config.model,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    },
  };
}

/**
 * Uses the configured model when there is one and the local router otherwise,
 * deciding per message so a key saved in the dashboard applies immediately.
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
      const model = await options.provider.resolveModel();
      if (!model) return local.respond(input);
      return createModelAssistantResponder({
        model,
        ...(options.toolbox ? { toolbox: options.toolbox } : {}),
        ...(options.system ? { system: options.system } : {}),
      }).respond(input);
    },
  };
}
