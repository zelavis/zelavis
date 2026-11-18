import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type AuthRuntime, type AuthTxBase, NO_REQUEST } from "../runtime/index.js";
import type { RelyingParty } from "./registration.js";
import { passkeyTables } from "./tables.js";

export const PasskeySettingsInput = Schema.Struct({
  rpId: Schema.String,
  rpName: Schema.String,
  origins: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
export type PasskeySettingsInput = typeof PasskeySettingsInput.Type;

const hostnameLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const secureOrigin = (value: string) => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined;
  if (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost")) return url;
  return undefined;
};

function normalize(input: PasskeySettingsInput): PasskeySettingsInput | undefined {
  const rpId = input.rpId.trim().toLowerCase();
  const rpName = input.rpName.trim();
  const labels = rpId.split(".");
  if (rpId.length > 253 || !labels.every((label) => hostnameLabel.test(label))) return undefined;
  if (rpId !== "localhost" && (labels.length < 2 || /^\d+$/u.test(labels.at(-1) ?? ""))) return undefined;
  if (!rpName || rpName.length > 100 || input.origins.length < 1 || input.origins.length > 10) return undefined;

  const origins = new Set<string>();
  for (const origin of input.origins) {
    const url = secureOrigin(origin);
    if (url === undefined || (url.hostname !== rpId && (rpId === "localhost" || !url.hostname.endsWith(`.${rpId}`)))) return undefined;
    origins.add(url.origin);
  }
  return { rpId, rpName, origins: [...origins] };
}

const publicSettings = ({ rpId, rpName, origins }: RelyingParty): PasskeySettingsInput => ({ rpId, rpName, origins });

export interface PasskeyDefaults {
  /** Trusted URLs from the runtime configuration, with the primary public origin first. */
  readonly publicOrigins?: ReadonlyArray<string>;
  readonly name?: string;
}

export function createPasskeySettings(runtime: AuthRuntime, defaults?: PasskeyDefaults) {
  const urls = (defaults?.publicOrigins ?? []).flatMap((origin) => secureOrigin(origin) ?? []);
  const rpId = urls[0]?.hostname ?? "localhost";
  const rpName = defaults?.name?.trim().slice(0, 100) || "Zelavis";
  const origins = [...new Set(urls.filter((url) => url.hostname === rpId || url.hostname.endsWith(`.${rpId}`)).map((url) => url.origin))].slice(0, 10);
  const initial = normalize({ rpId, rpName, origins }) ?? { rpId: "localhost", rpName, origins: ["http://localhost"] };
  const defaultSettings = { ...initial, revision: JSON.stringify(initial) };
  const table = passkeyTables.settings;
  const readRow = (tx: AuthTxBase) => tx.db.query(table).unique();
  const read = (tx: AuthTxBase) => Effect.map(readRow(tx), (row) => row ?? defaultSettings);

  const set = Effect.fn("auth.passkey.settings.set")(function* (input: PasskeySettingsInput) {
    const normalized = normalize(input);
    if (normalized === undefined) return null;
    const revision = crypto.randomUUID();
    return yield* runtime.mutation(NO_REQUEST, (tx) => Effect.gen(function* () {
      const row = yield* readRow(tx);
      const settings = { ...normalized, revision };
      if (row === null) yield* tx.db.insert(table, settings);
      else yield* tx.db.replace(table, row._id, settings);
      return publicSettings(settings);
    }));
  });
  const get = () => runtime.query(NO_REQUEST, (tx) => Effect.map(read(tx), publicSettings));
  const available = (request: Request) => Effect.map(get(), ({ rpId }) => rpId !== "localhost" || new URL(request.url).hostname === "localhost");
  return { read, get, set, available };
}

export type PasskeySettings = ReturnType<typeof createPasskeySettings>;
