import { Effect } from "effect";
import { integration } from "../core/runtime/effect-boundary.js";
import { StoreError } from "./errors.js";
import { isWriterLease, type LeaseRead, type LeaseStore } from "./writer-lease.js";

/**
 * A `LeaseStore` over the Platform's writer-lease routes (`/runtime/writer-leases/:partition`), for a runtime on
 * another host. Every call is bounded by a timeout, and anything but a plain answer is a `StoreError`, which a holder
 * treats as "could not renew": its gate then refuses writes once the lease can no longer be proved, so a partitioned
 * writer stops by itself without needing to hear that it was superseded.
 */
export interface HttpLeaseStoreOptions {
  /** The Platform's API root, e.g. `https://platform.example/zelavis/api/v1`. */
  readonly apiRoot: string;
  /** A service-account token with `database.replicate` at the system scope. */
  readonly token: string;
  readonly fetch?: typeof fetch;
  /** Milliseconds a call may take; 3000 unless given. */
  readonly timeoutMillis?: number;
}

export const httpLeaseStore = (options: HttpLeaseStoreOptions): LeaseStore => {
  const send = options.fetch ?? fetch;
  const timeout = options.timeoutMillis ?? 3000;
  const root = options.apiRoot.replace(/\/+$/, "");
  const call = (op: string, partition: string, init: { readonly method: string; readonly body?: unknown }) =>
    Effect.gen(function* () {
      const response = yield* integration((signal) => send(`${root}/runtime/writer-leases/${encodeURIComponent(partition)}`, {
        method: init.method,
        headers: { authorization: `Bearer ${options.token}`, accept: "application/json", ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        redirect: "manual",
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      }), { interruptible: true });
      return { status: response.status, text: yield* integration(() => response.text(), { interruptible: true }) };
    }).pipe(Effect.mapError((failure) => new StoreError({ op, cause: String((failure as { cause?: unknown }).cause ?? failure) })));
  const json = (op: string, text: string) => Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => new StoreError({ op, cause: "the lease authority answered something that is not JSON" }) });
  const unexpected = (op: string, status: number) => new StoreError({ op, cause: `the lease authority answered ${status}` });

  return {
    read: (partition) => Effect.gen(function* () {
      const answer = yield* call("lease.read", partition, { method: "GET" });
      if (answer.status === 404) return undefined;
      if (answer.status !== 200) return yield* unexpected("lease.read", answer.status);
      const body = (yield* json("lease.read", answer.text)) as { lease?: unknown; version?: unknown };
      if (!isWriterLease(body.lease) || typeof body.version !== "string") return yield* new StoreError({ op: "lease.read", cause: "the lease authority answered a malformed lease" });
      return { lease: body.lease, version: body.version } satisfies LeaseRead;
    }),
    create: (lease) => Effect.gen(function* () {
      const answer = yield* call("lease.create", lease.partition, { method: "PUT", body: { lease } });
      if (answer.status === 201) return true;
      if (answer.status === 409) return false;
      return yield* unexpected("lease.create", answer.status);
    }),
    replace: (observed, lease) => Effect.gen(function* () {
      const answer = yield* call("lease.replace", lease.partition, { method: "PUT", body: { lease, expectedVersion: observed.version } });
      if (answer.status === 200) return true;
      if (answer.status === 409) return false;
      return yield* unexpected("lease.replace", answer.status);
    }),
  };
};
