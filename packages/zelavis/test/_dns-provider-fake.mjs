// An in-memory DNS provider for tests, defined through the same `zelavis/edge:dns` contract a plugin uses. With a
// `test/_dns-authority.mjs` fixture, the records it holds are also what that fixture's authoritative servers answer.
import { defineDnsProviders } from "../dist/edge/dns-provider.js";

export const FAKE_TOKEN = "fake-dns-token-never-shown";

/**
 * @param {{ name?: string, zones?: { id: string, apex: string }[], authority?: { set(name: string, type: string, data: unknown[]): void, remove(name: string, type: string): void }, delayMs?: number }} [options]
 */
export function fakeDnsProvider(options = {}) {
  const zones = options.zones ?? [{ id: "zone-example", apex: "example.com" }];
  const records = new Map();
  const calls = [];
  let next = 1, hang = false, failNext;
  const publish = (name, type) => {
    if (!options.authority) return;
    const held = [...records.values()].filter(row => row.name === name && row.type === type);
    if (held.length === 0) options.authority.remove(name, type);
    else options.authority.set(name, type, held.map(row => type === "TXT" ? { type, strings: [row.content] }
      : type === "A" || type === "AAAA" ? { type, address: row.content } : { type, target: row.content }));
  };
  const definition = {
    name: options.name ?? "fakedns",
    title: "Fake DNS",
    credentials: [{ name: "token", label: "Token", secret: true }],
    tokenGuidance: "A test token that can edit the fake zones only.",
    createClient(credentials, context) {
      const guard = async (operation) => {
        calls.push(operation);
        if (credentials.token !== FAKE_TOKEN) throw new Error(`Fake DNS refused token ${credentials.token}`);
        if (hang) await new Promise((resolve, reject) => context.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        if (failNext) { const message = failNext; failNext = undefined; throw new Error(message); }
        if (options.delayMs) await new Promise(resolve => setTimeout(resolve, options.delayMs));
      };
      return {
        async zones({ cursor }) {
          await guard("zones");
          const start = cursor ? Number(cursor) : 0;
          const page = zones.slice(start, start + 2);
          return { zones: page, ...(start + 2 < zones.length ? { next: String(start + 2) } : {}) };
        },
        async records(zoneId, { name, type }) {
          await guard("records");
          return [...records.values()].filter(row => row.zoneId === zoneId && row.name === name && row.type === type).map(({ zoneId: _z, ...row }) => row);
        },
        async create(zoneId, record) {
          await guard("create");
          if (!zones.some(zone => zone.id === zoneId)) throw new Error("No such zone");
          const row = { id: `rec-${next++}`, zoneId, ...record };
          records.set(row.id, row);
          publish(row.name, row.type);
          const { zoneId: _z, ...created } = row;
          return created;
        },
        async remove(zoneId, recordId) {
          await guard("remove");
          const row = records.get(recordId);
          if (!row || row.zoneId !== zoneId) return;
          records.delete(recordId);
          publish(row.name, row.type);
        },
      };
    },
  };
  return {
    definition,
    plugin: (pluginName = "@test/dns-fake") => defineDnsProviders(pluginName, [definition]),
    records,
    calls,
    hang(value) { hang = value; },
    failNext(message) { failNext = message; },
  };
}

export const pluginEntry = (service, status = "installed") => ({ service, status, source: "community" });
