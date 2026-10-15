import { useLoaderData } from "react-router";

import { MarketplaceWorkspace } from "#/components/marketplace/MarketplaceWorkspace";
import { getMarketplaceAllowlist, getRuntimeConfig } from "#/lib/runtime-api";

export const handle = {
  pageLabel: "Marketplace",
} as const;

// The list is the Platform's, whichever scope this marketplace is opened from:
// it decides what may be installed anywhere.
export async function clientLoader() {
  return { allowlist: await getMarketplaceAllowlist(await getRuntimeConfig()) };
}

export default function PlatformMarketplaceRoute() {
  const { allowlist } = useLoaderData<typeof clientLoader>();
  return <MarketplaceWorkspace scope="platform" allowlist={allowlist} />;
}
