/**
 * The built-in Cloudflare DNS driver: four REST calls behind the `zelavis/edge:dns` contract.
 *
 * Provider-specific, so it lives behind the adapter boundary and only the Node adapter hands it to the composition.
 * It reads records and zones and creates and deletes single records; it is not an infrastructure-as-code engine.
 * The token is sent only as the `Authorization` header and never appears in an error message.
 */
import { Data, Effect, Schema } from "effect";
import { present } from "../core/runtime/effect-boundary.js";
import type { DnsProviderClient, DnsProviderDefinition, DnsProviderRecord } from "../edge/dns-provider.js";

export class CloudflareDnsError extends Data.TaggedError("CloudflareDnsError")<{ readonly message: string; readonly status?: number }> {}

const Failure = Schema.Struct({ code: Schema.optional(Schema.Number), message: Schema.String });
const Envelope = <A extends Schema.Top>(result: A) => Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optional(Schema.Array(Failure)),
  result: Schema.optional(Schema.NullOr(result)),
  result_info: Schema.optional(Schema.Struct({ page: Schema.optional(Schema.Number), total_pages: Schema.optional(Schema.Number) })),
});
const Zone = Schema.Struct({ id: Schema.String, name: Schema.String });
const RecordType = Schema.Literals(["A", "AAAA", "TXT", "CNAME"]);
const Record = Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String, content: Schema.String, ttl: Schema.Number });
const decodeZones = Schema.decodeUnknownEffect(Envelope(Schema.Array(Zone)));
const decodeRecords = Schema.decodeUnknownEffect(Envelope(Schema.Array(Record)));
const decodeRecord = Schema.decodeUnknownEffect(Envelope(Record));
const decodeAny = Schema.decodeUnknownEffect(Envelope(Schema.Unknown));
const isRecordType = Schema.is(RecordType);

const IDENTIFIER = /^[A-Za-z0-9]{1,64}$/u;
const MAX_BODY = 1_048_576;

export function createCloudflareDnsProvider(options: { readonly apiBase?: string } = {}): DnsProviderDefinition {
  const apiBase = (options.apiBase ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/u, "");
  return {
    name: "cloudflare",
    title: "Cloudflare",
    credentials: [{ name: "apiToken", label: "API token", secret: true }],
    tokenGuidance: "Create an API token with Zone → DNS → Edit for only the zones Zelavis should manage. It cannot change your account or other zones.",
    createClient(credentials, context): DnsProviderClient {
      const token = credentials.apiToken ?? "";
      const identifier = (value: string, what: string) => IDENTIFIER.test(value)
        ? Effect.succeed(value) : Effect.fail(new CloudflareDnsError({ message: `The Cloudflare ${what} id is invalid.` }));

      const request = Effect.fn("Cloudflare.request")(function* (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) {
        if (!/^[\x21-\x7e]{1,512}$/u.test(token)) return yield* new CloudflareDnsError({ message: "The Cloudflare API token is missing or malformed." });
        const response = yield* Effect.tryPromise({
          try: () => context.fetch(`${apiBase}${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            redirect: "error",
            ...(context.signal ? { signal: context.signal } : {}),
          }),
          catch: () => new CloudflareDnsError({ message: "Cloudflare could not be reached." }),
        });
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: () => new CloudflareDnsError({ message: "Cloudflare's answer could not be read.", status: response.status }),
        });
        if (text.length > MAX_BODY) return yield* new CloudflareDnsError({ message: "Cloudflare's answer is too large.", status: response.status });
        const parsed: unknown = yield* Effect.try({
          try: (): unknown => JSON.parse(text),
          catch: () => new CloudflareDnsError({ message: `Cloudflare answered HTTP ${response.status} without JSON.`, status: response.status }),
        });
        return { status: response.status, body: parsed };
      });

      const unwrap = <A>(status: number, envelope: { readonly success: boolean; readonly errors?: readonly { readonly message: string }[]; readonly result?: A | null }) => {
        if (envelope.success && envelope.result !== undefined && envelope.result !== null) return Effect.succeed(envelope.result);
        const detail = envelope.errors?.map((error) => error.message).filter(Boolean).join("; ").slice(0, 300) || `HTTP ${status}`;
        // The provider's own message, which names the request and never echoes the token.
        return Effect.fail(new CloudflareDnsError({ message: `Cloudflare refused the request: ${detail.split(token).join("[token]")}`, status }));
      };
      const malformed = (status: number) => () => new CloudflareDnsError({ message: "Cloudflare's answer has an unexpected shape.", status });

      const toRecord = (value: typeof Record.Type): Effect.Effect<DnsProviderRecord, CloudflareDnsError> => isRecordType(value.type)
        ? Effect.succeed({ id: value.id, name: value.name.toLowerCase().replace(/\.$/u, ""), type: value.type, content: value.content, ttl: value.ttl })
        : Effect.fail(new CloudflareDnsError({ message: "Cloudflare answered with a record of another type." }));

      return {
        zones: ({ cursor }) => present(Effect.gen(function* () {
          const page = cursor === undefined ? 1 : Number(cursor);
          if (!Number.isSafeInteger(page) || page < 1 || page > 10_000) return yield* new CloudflareDnsError({ message: "The zone page cursor is invalid." });
          const { status, body } = yield* request("GET", `/zones?page=${page}&per_page=50`);
          const envelope = yield* decodeZones(body).pipe(Effect.mapError(malformed(status)));
          const zones = yield* unwrap(status, envelope);
          const total = envelope.result_info?.total_pages ?? page;
          return {
            zones: zones.map((zone) => ({ id: zone.id, apex: zone.name.toLowerCase().replace(/\.$/u, "") })),
            ...(page < total ? { next: String(page + 1) } : {}),
          };
        })),
        records: (zoneId, { name, type }) => present(Effect.gen(function* () {
          const zone = yield* identifier(zoneId, "zone");
          const search = new URLSearchParams({ name, type, per_page: "100" });
          const { status, body } = yield* request("GET", `/zones/${zone}/dns_records?${search}`);
          const records = yield* unwrap(status, yield* decodeRecords(body).pipe(Effect.mapError(malformed(status))));
          return yield* Effect.forEach(records, toRecord);
        })),
        create: (zoneId, record) => present(Effect.gen(function* () {
          const zone = yield* identifier(zoneId, "zone");
          const { status, body } = yield* request("POST", `/zones/${zone}/dns_records`, {
            type: record.type, name: record.name, content: record.content, ttl: record.ttl,
          });
          return yield* toRecord(yield* unwrap(status, yield* decodeRecord(body).pipe(Effect.mapError(malformed(status)))));
        })),
        remove: (zoneId, recordId) => present(Effect.gen(function* () {
          const zone = yield* identifier(zoneId, "zone");
          const id = yield* identifier(recordId, "record");
          const { status, body } = yield* request("DELETE", `/zones/${zone}/dns_records/${id}`);
          if (status === 404) return;
          yield* unwrap(status, yield* decodeAny(body).pipe(Effect.mapError(malformed(status))));
        })),
      };
    },
  };
}

export const cloudflareDnsProvider = createCloudflareDnsProvider();
