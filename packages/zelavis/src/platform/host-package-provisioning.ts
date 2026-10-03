import type { ZelavisPrincipal } from "../core/runtime/contracts.js";
import type { ZelavisHostOperationBroker } from "./host-operations.js";

/** Public failure contains only the authorized caller's operation identity. */
export class ZelavisHostPackageProvisioningError extends Error {
  constructor(readonly operationId: string, timedOut = false) {
    super(`Host package installation ${timedOut ? "has not finished" : "failed"}. Check operation ${operationId} in the host-operation audit and the server package repositories, then retry.`);
    this.name = "ZelavisHostPackageProvisioningError";
  }
}

/** Creating a Project never grants package authority: the broker checks each installed manifest. */
export async function provisionProjectHostPackages(
  broker: ZelavisHostOperationBroker,
  sets: readonly string[],
  principal: ZelavisPrincipal | undefined,
): Promise<void> {
  for (const set of sets) {
    let record = await broker.submit({ operation: "zelavis.packages-install", version: "v1", arguments: { set }, deadlineMs: 900_000 }, principal);
    const until = Date.now() + 905_000;
    while (record.agent?.status === "queued" || record.agent?.status === "running" || !record.agent) {
      if (Date.now() >= until) throw new ZelavisHostPackageProvisioningError(record.operationId, true);
      await new Promise((resolve) => setTimeout(resolve, 250));
      record = await broker.get(record.operationId, principal);
    }
    if (record.agent.status !== "succeeded") throw new ZelavisHostPackageProvisioningError(record.operationId);
  }
}
