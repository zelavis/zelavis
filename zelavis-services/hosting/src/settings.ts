import { Effect, Schema } from "effect";
import { dateString, decode, invalid, ok, route, strict, table, unavailable, type Commerce, type HostingStore } from "./runtime.js";

const input = Schema.Struct({
  publicBaseUrl: Schema.String.check(Schema.isBetweenLength(1, 2048)),
  provider: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,31}$/u)),
  graceDays: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 }))),
});
const settingsSchema = Schema.Struct({ ...input.fields, graceDays: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })), updatedAt: dateString });
const settings = table("hosting_settings", Schema.decodeUnknownSync(settingsSchema));
const readInput = Schema.decodeUnknownSync(input, strict);

export function publicBase(value: string): string {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!(url.protocol === "https:" || url.protocol === "http:" && loopback) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new TypeError("Public base URL must be an HTTPS origin or an HTTP loopback origin.");
  }
  return url.origin;
}

export function hostingSettings(store: HostingStore, commerce: Commerce, now: () => number) {
  const get = () => store.get(settings, "default");
  const require = () => get().pipe(Effect.flatMap(value => value ? Effect.succeed(value) : Effect.fail(unavailable())));
  const access = { permissions: ["hosting.manage"] };
  const routes = [
    route("settings", "get", "GET", access, () => Effect.gen(function* () {
      return ok({ settings: (yield* get()) ?? null, providers: yield* (yield* commerce()).payments.listProviders() });
    })),
    route("settings", "set", "PUT", access, ({ body }) => Effect.gen(function* () {
      const value = yield* decode(readInput, body, "Supply a public base URL, a payment provider and optionally 1–30 grace days.");
      const publicBaseUrl = yield* decode(publicBase, value.publicBaseUrl, "Public base URL must be an HTTPS origin or an HTTP loopback origin.");
      const providers = yield* (yield* commerce()).payments.listProviders();
      if (!providers.includes(value.provider)) return yield* invalid("Choose a payment provider registered with Ecommerce.");
      const saved = yield* store.transaction(tx => Effect.gen(function* () {
        const current = yield* store.get(settings, "default", tx);
        const next = { ...value, publicBaseUrl, graceDays: value.graceDays ?? current?.graceDays ?? 7, updatedAt: new Date(now()).toISOString() };
        yield* store.put(tx, settings.collection, "default", next, current !== undefined);
        return next;
      }));
      return ok({ settings: saved, providers });
    })),
  ];
  return { settings, get, require, routes };
}
