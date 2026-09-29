import { loadBundledServiceCatalog } from "../dist/adapters/_local-runtime.js";

/**
 * The bundled Marketplace and Auth packages, selected the way the host
 * adapters select them. The low-level `zelavis()` composes only what it is
 * given, so a test that wants those product services passes this as
 * `serviceRegistry`.
 */
export async function bundledServiceRegistry() {
  return {
    catalog: await loadBundledServiceCatalog([
      { name: "@zelavis/marketplace", status: "installed", order: 10 },
      { name: "@zelavis/auth", status: "installed", order: 20 },
    ]),
  };
}
