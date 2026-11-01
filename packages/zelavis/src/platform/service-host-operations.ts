import { Effect } from "effect";
import { IntegrationFailure, integrationValue, present } from "../core/runtime/effect-boundary.js";
import { ZelavisHostOperationNotFoundError, type ZelavisHostOperationBroker, type ZelavisHostOperationRecord } from "./host-operations.js";
import type { ZelavisServiceHostOperations } from "../service.js";

/**
 * The handle a plugin gets: the broker, narrowed to the operations its manifest names.
 *
 * The plugin never has authority of its own. Each call carries the principal of the request the plugin is
 * serving, so the broker authorizes that caller's permissions exactly as if they had asked directly; the
 * manifest only limits which operations the plugin can name, and an operation it did not name is refused as
 * if it did not exist, for submitting and for reading a record alike.
 */
export function scopeHostOperations(broker: ZelavisHostOperationBroker, allowed: readonly string[]): ZelavisServiceHostOperations {
  const names = Object.freeze([...allowed]);
  const handle: ZelavisServiceHostOperations = {
    allowed: names,
    submit: (input, principal) => {
      if (!names.includes(input.operation)) {
        return Promise.reject(new ZelavisHostOperationNotFoundError(`This service's manifest does not name the host operation "${input.operation}".`));
      }
      return broker.submit(input, principal);
    },
    get: (operationId, principal) => present(Effect.gen(function* (): Effect.fn.Return<ZelavisHostOperationRecord, IntegrationFailure> {
      const record = yield* integrationValue(broker.get(operationId, principal));
      if (!names.includes(record.operation)) return yield* new IntegrationFailure(new ZelavisHostOperationNotFoundError("No such host operation."));
      return record;
    })),
  };
  return Object.freeze(handle);
}
