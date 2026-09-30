import { MarketplaceWorkspace } from "#/components/marketplace/MarketplaceWorkspace";

export const handle = {
  pageLabel: "Marketplace",
} as const;

export default function ProjectMarketplaceRoute() {
  return <MarketplaceWorkspace scope="project" />;
}
