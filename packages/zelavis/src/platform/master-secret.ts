import type { ZelavisSystemStore } from "../system-store.js";

const NAMESPACE = "platform";
const KEY = "master-secret";

/**
 * The Platform's at-rest encryption secret, created once.
 *
 * Creation is if-absent and the loser re-reads, so two runtimes starting
 * together on one store agree on a single secret instead of each encrypting
 * with its own.
 *
 * It lives in the System Store it protects, so this guards a copied export or a
 * leaked field, not a compromised store. Anything that must survive that needs
 * an external secret provider.
 */
export async function loadPlatformMasterSecret(store: ZelavisSystemStore): Promise<string> {
  const existing = await store.get(NAMESPACE, KEY);
  if (existing && typeof existing.value === "string") return existing.value;
  const candidate = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  await store.setIfAbsent(NAMESPACE, KEY, candidate);
  const settled = await store.get(NAMESPACE, KEY);
  if (!settled || typeof settled.value !== "string") {
    throw new Error("The Platform master secret could not be established.");
  }
  return settled.value;
}
