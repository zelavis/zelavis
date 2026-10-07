import type { CapacityProvider } from "zelavis/provider";
import { createCapacityProvider, type CapacityProviderOptions } from "./capacity-provider.js";
import { createHetznerCloud } from "./hetzner-cloud.js";
import { aesGcmSecretCodec } from "./provisioning-state.js";

/**
 * The one entry the Platform calls: a `CapacityProvider` over Hetzner, with Alchemy as the
 * engine and its provisioning state in the Platform's own conditional store.
 *
 * The Platform composes this from a bundled copy of this package (see `scripts/bundle.mjs`), so
 * the caller never imports Alchemy or any cloud client. Everything the Platform decides is
 * passed in: the sealed-state key, the approved machine classes and ceiling, how enrollment is
 * recognized, and the first-boot script. The token is used for the life of the returned
 * provider and is not stored here.
 */
export interface HetznerCapacityOptions {
  readonly token: string;
  readonly platformId: string;
  readonly workerId: string;
  /** Alchemy's home and working directory; created if missing. */
  readonly workDir: string;
  readonly store: CapacityProviderOptions["store"];
  /** 32 bytes, from the Platform's key management; seals secrets inside the provisioning state. */
  readonly secretKey: Uint8Array;
  readonly defaults: CapacityProviderOptions["defaults"];
  readonly enrollment: CapacityProviderOptions["enrollment"];
  readonly userData?: CapacityProviderOptions["userData"];
  /** Override the API root; for tests against a fake only. */
  readonly endpoint?: string;
}

export function createHetznerCapacityProvider(options: HetznerCapacityOptions): CapacityProvider {
  return createCapacityProvider({
    platformId: options.platformId,
    workerId: options.workerId,
    cloud: createHetznerCloud({
      token: options.token,
      workDir: options.workDir,
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    }),
    store: options.store,
    secrets: aesGcmSecretCodec(options.secretKey),
    defaults: options.defaults,
    enrollment: options.enrollment,
    ...(options.userData === undefined ? {} : { userData: options.userData }),
  });
}
