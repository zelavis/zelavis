// A local DNS server for tests: one UDP and TCP port that plays both a caching recursive resolver (queries with RD=1)
// and the authoritative servers of its zones (RD=0). Every nameserver of every zone resolves to 127.0.0.1, so an
// authoritative query reaches this same port; resolvers under test take that port as `authoritativePort`.
import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { decodeDnsMessage, encodeDnsResponse } from "../dist/edge/dns-wire.js";

const NOERROR = 0, SERVFAIL = 2, NXDOMAIN = 3;

/**
 * @param {import("node:test").TestContext} t
 * @param {{ zones: Map<string, { ns: string[], records?: Map<string, unknown[]>, authoritative?: boolean }>, noNegativeCache?: boolean }} options
 */
export async function startDnsAuthority(t, { zones, noNegativeCache = false }) {
  const state = new Map([...zones].map(([apex, zone]) => [apex, { ...zone, records: new Map(zone.records ?? []) }]));
  const nameservers = new Set([...state.values()].flatMap(zone => zone.ns));
  const cache = new Map();
  const queries = [];
  let dropAuthoritative = false, truncateAuthoritative = false;

  const zoneOf = name => {
    let best;
    for (const apex of state.keys()) {
      if ((name === apex || name.endsWith(`.${apex}`)) && (best === undefined || apex.length > best.length)) best = apex;
    }
    return best;
  };
  const soa = apex => ({ name: apex, ttl: 1800, data: { type: "SOA", primary: state.get(apex).ns[0] } });
  const lookup = (apex, name, type) => {
    const zone = state.get(apex);
    if (type === "NS" && name === apex) return zone.ns.map(target => ({ name, ttl: 300, data: { type: "NS", target } }));
    if (type === "SOA" && name === apex) return [soa(apex)];
    if (type === "A" && nameservers.has(name)) return [{ name, ttl: 300, data: { type: "A", address: "127.0.0.1" } }];
    return (zone.records.get(`${name}|${type}`) ?? []).map(data => ({ name, ttl: 60, data }));
  };
  const exists = (apex, name) => name === apex || nameservers.has(name) ||
    [...state.get(apex).records.keys()].some(key => { const owner = key.split("|")[0]; return owner === name || owner.endsWith(`.${name}`); });

  /** One zone's answer; a recursive answer follows a CNAME once into another zone it knows. */
  const answer = (name, type, recursive) => {
    const apex = zoneOf(name);
    if (!apex) return { rcode: recursive ? NXDOMAIN : SERVFAIL, answers: [], authority: [] };
    const records = lookup(apex, name, type);
    if (records.length) return { rcode: NOERROR, answers: records, authority: [] };
    const alias = type === "CNAME" ? [] : lookup(apex, name, "CNAME");
    if (alias.length) {
      if (!recursive) return { rcode: NOERROR, answers: alias, authority: [] };
      const next = answer(alias[0].data.target, type, false);
      return { ...next, answers: [...alias, ...next.answers] };
    }
    return { rcode: exists(apex, name) ? NOERROR : NXDOMAIN, answers: [], authority: [soa(apex)] };
  };

  const respond = (bytes, transport) => {
    const query = decodeDnsMessage(bytes);
    const question = query.questions[0];
    if (query.response || query.questions.length !== 1) return undefined;
    const rd = query.recursionDesired;
    queries.push({ name: question.name, type: question.type, rd, transport });
    if (!rd && dropAuthoritative) return undefined;
    const head = { id: query.id, response: true, recursionDesired: rd, questions: [question] };
    let reply;
    if (rd) {
      const key = `${question.name}|${question.type}`;
      reply = cache.get(key) ?? answer(question.name, question.type, true);
      if (!noNegativeCache && reply.answers.length === 0) cache.set(key, reply);
      reply = { ...reply, authoritative: false, truncated: false };
    } else {
      const apex = zoneOf(question.name);
      reply = { ...answer(question.name, question.type, false), authoritative: apex !== undefined && state.get(apex).authoritative !== false, truncated: false };
      if (transport === "udp" && truncateAuthoritative) reply = { ...reply, truncated: true, answers: [], authority: [] };
    }
    return encodeDnsResponse({ ...head, ...reply });
  };

  const sockets = new Set();
  const tcp = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let buffered = Buffer.alloc(0);
    socket.on("data", chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) {
        const length = buffered.readUInt16BE(0);
        const reply = respond(buffered.subarray(2, 2 + length), "tcp");
        buffered = buffered.subarray(2 + length);
        if (reply) socket.write(Buffer.concat([Buffer.from([reply.length >> 8, reply.length & 0xff]), reply]));
      }
    });
  });
  // UDP takes a free port first; TCP must get the same one, so a port taken for TCP starts over with another.
  let udp, port;
  for (let attempt = 0; ; attempt++) {
    udp = createSocket("udp4");
    await new Promise((resolve, reject) => { udp.once("error", reject); udp.bind(0, "127.0.0.1", resolve); });
    port = udp.address().port;
    const listening = await new Promise(resolve => {
      tcp.once("error", () => resolve(false));
      tcp.listen(port, "127.0.0.1", () => resolve(true));
    });
    if (listening) break;
    udp.close();
    if (attempt === 4) throw new Error("No port was free for both UDP and TCP.");
  }
  tcp.removeAllListeners("error");
  udp.on("message", (message, peer) => {
    const reply = respond(message, "udp");
    if (reply) udp.send(reply, peer.port, peer.address);
  });
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    udp.close();
    tcp.close(() => resolve());
  }));

  const ownerZone = name => {
    const apex = zoneOf(name);
    if (!apex) throw new Error(`The fixture serves no zone for ${name}.`);
    return state.get(apex);
  };
  return {
    address: `127.0.0.1:${port}`,
    port,
    queries,
    set(name, type, data) { ownerZone(name).records.set(`${name}|${type}`, data); },
    remove(name, type) { ownerZone(name).records.delete(`${name}|${type}`); },
    dropAuthoritative(value) { dropAuthoritative = value; },
    truncateAuthoritative(value) { truncateAuthoritative = value; },
  };
}
