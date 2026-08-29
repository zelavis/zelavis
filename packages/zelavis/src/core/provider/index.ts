import { defineCompatibilityDate } from "../runtime/compatibility.js";
import type { ArtifactStore } from "../artifact/index.js";

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

export interface ZelavisCapacityResources {
  readonly cpuCores?: number;
  readonly memoryBytes?: number;
  readonly diskBytes?: number;
}

export interface ZelavisCapacityNode {
  readonly id: string;
  readonly provider: string;
  readonly state: "provisioning" | "ready" | "releasing" | "failed";
  readonly region?: string;
  readonly resources?: ZelavisCapacityResources;
  readonly labels?: Readonly<Record<string, string>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ZelavisCapacityProvisionInput {
  /** Stable caller-generated idempotency key. */
  readonly requestId: string;
  readonly platformId: string;
  readonly region?: string;
  readonly resources?: ZelavisCapacityResources;
  readonly labels?: Readonly<Record<string, string>>;
}

/**
 * Provider capacity creates and releases Nodes only. Fabric remains the sole
 * authority that allocates Projects and decides their placement on those Nodes.
 */
export interface CapacityProvider {
  list(): Promise<readonly ZelavisCapacityNode[]>;
  get(nodeId: string): Promise<ZelavisCapacityNode | undefined>;
  provision(input: ZelavisCapacityProvisionInput): Promise<ZelavisCapacityNode>;
  release(nodeId: string): Promise<void>;
}

export interface ZelavisProviderCapability<
  TApi = unknown,
  TKind extends ZelavisProviderCapabilityKind = ZelavisProviderCapabilityKind,
> {
  readonly kind: TKind;
  readonly api: TApi;
}

export type ZelavisArtifactStoreCapability = ZelavisProviderCapability<
  ArtifactStore,
  "artifacts"
>;

export type ZelavisCapacityProviderCapability = ZelavisProviderCapability<
  CapacityProvider,
  "capacity"
>;

export function artifactStoreCapability(
  store: ArtifactStore,
): ZelavisArtifactStoreCapability {
  if (
    !store ||
    typeof store.has !== "function" ||
    typeof store.get !== "function" ||
    typeof store.put !== "function"
  ) {
    throw new TypeError("ArtifactStore must implement has, get, and put.");
  }
  return Object.freeze({ kind: "artifacts", api: store });
}

export function capacityProviderCapability(
  provider: CapacityProvider,
): ZelavisCapacityProviderCapability {
  if (
    !provider ||
    typeof provider.list !== "function" ||
    typeof provider.get !== "function" ||
    typeof provider.provision !== "function" ||
    typeof provider.release !== "function"
  ) {
    throw new TypeError(
      "CapacityProvider must implement list, get, provision, and release.",
    );
  }
  return Object.freeze({ kind: "capacity", api: provider });
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
