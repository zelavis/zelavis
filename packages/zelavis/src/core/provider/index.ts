import { defineCompatibilityDate } from "../runtime/compatibility.js";

export const ZELAVIS_PROVIDER_V1 = "ZELAVIS_PROVIDER_V1" as const;

export type ZelavisProviderCapabilityKind =
  | "capacity"
  | "artifacts"
  | "dns"
  | "network"
  | "secrets"
  | "backups"
  | "telemetry"
  | (string & {});

export interface ZelavisProviderCapability<
  TApi = unknown,
  TKind extends ZelavisProviderCapabilityKind = ZelavisProviderCapabilityKind,
> {
  readonly kind: TKind;
  readonly api: TApi;
}

export interface ZelavisProviderDefinition {
  readonly contractVersion: typeof ZELAVIS_PROVIDER_V1;
  readonly name: string;
  readonly version?: string;
  readonly compatibilityDate?: string;
  readonly capabilities: readonly ZelavisProviderCapability[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Define a provider plugin through capability negotiation rather than a single
 * cloud-specific interface. Fabric remains responsible for placement policy.
 */
export function defineProvider(
  provider: ZelavisProviderDefinition,
): Readonly<ZelavisProviderDefinition> {
  if (!provider || typeof provider !== "object") {
    throw new TypeError("A Zelavis provider definition is required.");
  }
  if (provider.contractVersion !== ZELAVIS_PROVIDER_V1) {
    throw new TypeError(
      `Provider contractVersion must be ${ZELAVIS_PROVIDER_V1}.`,
    );
  }
  if (!provider.name?.trim()) {
    throw new TypeError("Provider name is required.");
  }
  if (!Array.isArray(provider.capabilities)) {
    throw new TypeError("Provider capabilities must be an array.");
  }
  if (provider.compatibilityDate) {
    defineCompatibilityDate(provider.compatibilityDate);
  }

  const capabilityKinds = new Set<string>();
  for (const capability of provider.capabilities) {
    if (!capability?.kind?.trim()) {
      throw new TypeError("Every provider capability requires a kind.");
    }
    if (capabilityKinds.has(capability.kind)) {
      throw new TypeError(
        `Provider capability "${capability.kind}" is declared more than once.`,
      );
    }
    capabilityKinds.add(capability.kind);
  }

  return Object.freeze({
    ...provider,
    capabilities: Object.freeze(
      provider.capabilities
        .map((capability) => Object.freeze({ ...capability }))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    ),
    metadata: provider.metadata
      ? Object.freeze({ ...provider.metadata })
      : undefined,
  });
}

export function getProviderCapability<TApi = unknown>(
  provider: Pick<ZelavisProviderDefinition, "capabilities">,
  kind: ZelavisProviderCapabilityKind,
): TApi | undefined {
  return provider.capabilities.find((capability) => capability.kind === kind)
    ?.api as TApi | undefined;
}
