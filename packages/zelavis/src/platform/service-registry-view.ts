import type { ZelavisServiceRegistryEntry, ZelavisServiceRegistryStateEntry } from "../service.js";

/** Catalogue identity shared by public transports. Acquisition references stay private. */
export interface PublicServiceRegistryIdentity {
  name: string;
  namespace?: string;
  version?: string;
  kind?: string;
  status: "installed" | "available";
  source?: "official" | "community";
  order?: number;
}

/** Administrative diagnostics only; never include this shape in public discovery. */
export interface ServiceSourceDiagnostic extends PublicServiceRegistryIdentity {
  specifier?: string;
}

export function publicServiceRegistryIdentity<TContext>(
  entry: Readonly<ZelavisServiceRegistryEntry<TContext>> | Readonly<ZelavisServiceRegistryStateEntry>,
): PublicServiceRegistryIdentity {
  const service = "service" in entry ? entry.service : undefined;
  return {
    name: "service" in entry ? entry.service.name : entry.name,
    namespace: service?.namespace,
    version: service?.version,
    kind: service?.kind,
    status: entry.status ?? "available",
    source: entry.source,
    order: entry.order,
  };
}
