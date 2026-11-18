/**
 * TXT lookups answered by the zone's own authoritative nameservers, for Project domain ownership proof.
 *
 * A recursive resolver caches a negative answer for the zone's SOA minimum, so a customer who checks before adding the
 * challenge record would otherwise wait out that cache after adding it. Here the recursive resolver is used only to find
 * the zone and its nameservers: the SOA in the challenge name's own response names the zone (asking for the NS of the
 * hostname instead would follow a CNAME into another zone), and the TXT question goes to that zone's servers with
 * recursion off. Only an authoritative answer (AA set) from one of those addresses decides.
 *
 * Bounded per lookup: at most 12 recursive and 5 authoritative sends (4 servers plus one TCP retry of a truncated
 * answer), each answered within `queryTimeoutMs`, UDP answers of at most 4096 bytes, TCP answers of at most 65535, and
 * one socket open at a time, closed when its query ends or is interrupted. Not supported: following a CNAME at the
 * challenge name (`ECNAME`), following a referral from a stale parent zone, and DNSSEC validation.
 */
import { createSocket } from "node:dgram";
import { connect, isIP } from "node:net";
import { getServers } from "node:dns";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { present } from "../core/runtime/effect-boundary.js";
import { decodeDnsMessage, encodeDnsQuery, type DnsMessage, type DnsQuestion } from "../edge/dns-wire.js";
import type { DnsTxtResolver } from "../domain-verifier.js";
import type { DnsAuthoritativeTxt } from "../edge/dns-provider.js";

export interface AuthoritativeDnsOptions {
  /** "ip" or "ip:port" ("[ipv6]:port"); default node:dns getServers(). Tests pass the fixture. */
  readonly recursiveServers?: readonly string[];
  /** Default 53. Tests pass the fixture's port. */
  readonly authoritativePort?: number;
  /** Per query; default 1500. */
  readonly queryTimeoutMs?: number;
}

/** `ENOTFOUND` and `ECNAME` mean the customer's record is missing or unusable; the rest mean DNS could not answer. */
export type DnsLookupCode = "ENOTFOUND" | "ESERVFAIL" | "ECNAME" | "ETIMEOUT" | "EMALFORMED";
export class DnsLookupError extends Data.TaggedError("DnsLookupError")<{ readonly code: DnsLookupCode; readonly message: string }> {}

interface Server { readonly host: string; readonly port: number; readonly family: 4 | 6 }
type Budget = { recursive: number; authoritative: number };

const MAX_UDP_BYTES = 4096;
const MAX_TCP_BYTES = 65_535;
const MAX_RECURSIVE_SERVERS = 3;
const MAX_AUTHORITIES = 4;

const lookupError = (code: DnsLookupCode, message: string) => new DnsLookupError({ code, message });
const describe = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const validPort = (port: number) => Number.isInteger(port) && port >= 1 && port <= 65_535;

function parseServer(text: string, defaultPort: number): Server | undefined {
  const bracketed = /^\[([^\]]+)\]:([0-9]{1,5})$/.exec(text);
  const [host, port] = bracketed ? [bracketed[1]!, Number(bracketed[2])]
    : isIP(text) ? [text, defaultPort]
      : [text.slice(0, text.lastIndexOf(":")), Number(text.slice(text.lastIndexOf(":") + 1))];
  const family = isIP(host);
  return (family === 4 || family === 6) && validPort(port) ? { host, port, family } : undefined;
}

function decode(bytes: Uint8Array): DnsMessage | DnsLookupError {
  try {
    return decodeDnsMessage(bytes);
  } catch (cause) {
    return lookupError("EMALFORMED", `A DNS server sent a malformed answer: ${describe(cause)}`);
  }
}

const answers = (id: number, question: DnsQuestion) => (message: DnsMessage) => message.response && message.id === id &&
  message.questions.length === 1 && message.questions[0]!.name === question.name && message.questions[0]!.type === question.type;

/** One UDP exchange on a connected socket, so only the server's own address can answer. */
const udpExchange = (server: Server, bytes: Uint8Array, matches: (message: DnsMessage) => boolean) =>
  Effect.callback<DnsMessage, DnsLookupError>(resume => {
    const socket = createSocket(server.family === 6 ? "udp6" : "udp4");
    let open = true;
    const close = () => { if (open) { open = false; socket.close(); } };
    const finish = (outcome: Effect.Effect<DnsMessage, DnsLookupError>) => { close(); resume(outcome); };
    const unreachable = (error: Error) => finish(Effect.fail(lookupError("ESERVFAIL", `DNS server ${server.host} is unreachable: ${error.message}`)));
    socket.on("error", unreachable);
    socket.on("message", message => {
      if (message.length > MAX_UDP_BYTES) return finish(Effect.fail(lookupError("EMALFORMED", "A DNS answer over UDP was too long.")));
      const decoded = decode(message);
      if (decoded instanceof DnsLookupError) return finish(Effect.fail(decoded));
      // An answer to another question (a stale or stray datagram) is not this query's answer.
      if (matches(decoded)) finish(Effect.succeed(decoded));
    });
    socket.connect(server.port, server.host, () => {
      if (open) socket.send(bytes, error => { if (error) unreachable(error); });
    });
    return Effect.sync(close);
  });

/** One TCP exchange with the 2-byte length prefix (RFC 1035 section 4.2.2). */
const tcpExchange = (server: Server, bytes: Uint8Array, matches: (message: DnsMessage) => boolean) =>
  Effect.callback<DnsMessage, DnsLookupError>(resume => {
    const socket = connect({ host: server.host, port: server.port });
    const chunks: Buffer[] = [];
    let received = 0;
    const finish = (outcome: Effect.Effect<DnsMessage, DnsLookupError>) => { socket.destroy(); resume(outcome); };
    socket.on("error", error => finish(Effect.fail(lookupError("ESERVFAIL", `DNS server ${server.host} is unreachable: ${error.message}`))));
    socket.on("close", () => finish(Effect.fail(lookupError("ESERVFAIL", `DNS server ${server.host} closed the connection without answering.`))));
    socket.on("connect", () => socket.write(Buffer.concat([Buffer.from([bytes.length >> 8, bytes.length & 0xff]), bytes])));
    socket.on("data", (data: string | Buffer) => {
      const chunk = typeof data === "string" ? Buffer.from(data, "latin1") : data;
      received += chunk.length;
      if (received > MAX_TCP_BYTES + 2) return finish(Effect.fail(lookupError("EMALFORMED", "A DNS answer over TCP was too long.")));
      chunks.push(chunk);
      if (received < 2) return;
      const all = Buffer.concat(chunks);
      const length = all.readUInt16BE(0);
      if (received < 2 + length) return;
      const decoded = decode(all.subarray(2, 2 + length));
      if (decoded instanceof DnsLookupError) return finish(Effect.fail(decoded));
      finish(matches(decoded) ? Effect.succeed(decoded)
        : Effect.fail(lookupError("EMALFORMED", `DNS server ${server.host} answered another question.`)));
    });
    return Effect.sync(() => socket.destroy());
  });

export function createAuthoritativeDnsTxtResolver(options: AuthoritativeDnsOptions = {}): DnsTxtResolver & DnsAuthoritativeTxt {
  const authoritativePort = options.authoritativePort ?? 53;
  const queryTimeoutMs = options.queryTimeoutMs ?? 1500;
  if (!validPort(authoritativePort)) throw new RangeError("authoritativePort must be a port number.");
  if (!Number.isInteger(queryTimeoutMs) || queryTimeoutMs < 1 || queryTimeoutMs > 60_000) {
    throw new RangeError("queryTimeoutMs must be between 1 and 60000.");
  }
  const configured = options.recursiveServers;

  const spend = (budget: Budget, kind: keyof Budget) => Effect.suspend(() => {
    if (budget[kind] <= 0) return Effect.fail(lookupError("ESERVFAIL", `The DNS lookup used all of its ${kind} queries.`));
    budget[kind]--;
    return Effect.void;
  });

  const timed = (exchange: Effect.Effect<DnsMessage, DnsLookupError>, server: Server) => exchange.pipe(Effect.timeoutOrElse({
    duration: queryTimeoutMs,
    orElse: () => Effect.fail(lookupError("ETIMEOUT", `DNS server ${server.host} did not answer within ${queryTimeoutMs} ms.`)),
  }));

  /** UDP first; a truncated answer is asked again over TCP. */
  const query = Effect.fn("AuthoritativeDns.query")(function* (
    budget: Budget, kind: keyof Budget, server: Server, question: DnsQuestion, recursionDesired: boolean,
  ) {
    const id = crypto.getRandomValues(new Uint16Array(1))[0]!;
    const bytes = yield* Effect.try({
      try: () => encodeDnsQuery(id, question, recursionDesired),
      catch: cause => lookupError("EMALFORMED", `The DNS question for "${question.name}" is invalid: ${describe(cause)}`),
    });
    const matches = answers(id, question);
    yield* spend(budget, kind);
    const reply = yield* timed(udpExchange(server, bytes, matches), server);
    if (!reply.truncated) return reply;
    yield* spend(budget, kind);
    return yield* timed(tcpExchange(server, bytes, matches), server);
  });

  /** Ask the recursive servers in turn, starting with the one that answered last; NOERROR or NXDOMAIN is an answer. */
  const recursive = Effect.fn("AuthoritativeDns.recursive")(function* (
    budget: Budget, servers: readonly Server[], preferred: { index: number }, question: DnsQuestion,
  ) {
    for (let offset = 0; offset < servers.length; offset++) {
      const index = (preferred.index + offset) % servers.length;
      const reply = yield* Effect.result(query(budget, "recursive", servers[index]!, question, true));
      if (reply._tag === "Success" && (reply.success.rcode === 0 || reply.success.rcode === 3)) {
        preferred.index = index;
        return reply.success;
      }
    }
    return yield* lookupError("ESERVFAIL", `No recursive DNS server answered ${question.type} ${question.name}.`);
  });

  const lookup = Effect.fn("AuthoritativeDns.lookup")(function* (name: string, every: boolean) {
    const servers = (configured ?? getServers()).flatMap(text => parseServer(text, 53) ?? []).slice(0, MAX_RECURSIVE_SERVERS);
    if (servers.length === 0) return yield* lookupError("ESERVFAIL", "No recursive DNS server is configured.");
    const budget: Budget = { recursive: 12, authoritative: every ? MAX_AUTHORITIES * 2 : MAX_AUTHORITIES + 1 };
    const preferred = { index: 0 };
    const aliased = (message: DnsMessage) => message.answers.some(record => record.name === name && record.data.type === "CNAME");

    // 1. The zone: the SOA owner from the challenge name's own response (an answer when it is the apex, else authority).
    const discovery = yield* recursive(budget, servers, preferred, { name, type: "SOA" });
    if (aliased(discovery)) return yield* lookupError("ECNAME", `"${name}" is a CNAME; the TXT record must be at that name itself.`);
    const soa = discovery.answers.find(record => record.name === name && record.data.type === "SOA") ??
      discovery.authority.find(record => record.data.type === "SOA");
    if (!soa || soa.name === "") return yield* lookupError("ENOTFOUND", `No DNS zone holds "${name}".`);
    const apex = soa.name;
    if (name !== apex && !name.endsWith(`.${apex}`)) {
      return yield* lookupError("ESERVFAIL", `The DNS zone "${apex}" reported for "${name}" does not contain it.`);
    }

    // 2. The zone's nameservers.
    const delegation = yield* recursive(budget, servers, preferred, { name: apex, type: "NS" });
    const hosts = [...new Set(delegation.answers.flatMap(record =>
      record.name === apex && record.data.type === "NS" ? [record.data.target] : []))].sort().slice(0, MAX_AUTHORITIES);
    if (hosts.length === 0) return yield* lookupError("ESERVFAIL", `The DNS zone "${apex}" lists no nameservers.`);

    // 3. Their addresses, IPv4 first.
    const authorities: Server[] = [];
    for (const type of ["A", "AAAA"] as const) {
      for (const host of hosts) {
        if (authorities.length >= MAX_AUTHORITIES) break;
        const reply = yield* Effect.result(recursive(budget, servers, preferred, { name: host, type }));
        if (reply._tag === "Failure") continue;
        for (const record of reply.success.answers) {
          if (record.data.type !== type || authorities.length >= MAX_AUTHORITIES) continue;
          const server = { host: record.data.address, port: authoritativePort, family: type === "A" ? 4 : 6 } as const;
          if (!authorities.some(known => known.host === server.host)) authorities.push(server);
        }
      }
    }
    if (authorities.length === 0) return yield* lookupError("ESERVFAIL", `No address was found for the nameservers of "${apex}".`);

    // 4. The TXT question, recursion off, decided only by an authoritative answer: the first one, or every server's.
    if (every) {
      const answered: (readonly (readonly string[])[])[] = [];
      for (const server of authorities) {
        const message = yield* query(budget, "authoritative", server, { name, type: "TXT" }, false);
        if (!message.authoritative || message.recursionDesired || (message.rcode !== 0 && message.rcode !== 3)) {
          return yield* lookupError("ESERVFAIL", `The nameserver ${server.host} of "${apex}" did not answer authoritatively for "${name}".`);
        }
        if (aliased(message)) return yield* lookupError("ECNAME", `"${name}" is a CNAME; the TXT record must be at that name itself.`);
        answered.push(message.rcode === 3 ? [] :
          message.answers.flatMap(record => record.name === name && record.data.type === "TXT" ? [record.data.strings] : []));
      }
      return answered;
    }
    for (const server of authorities) {
      const reply = yield* Effect.result(query(budget, "authoritative", server, { name, type: "TXT" }, false));
      if (reply._tag === "Failure") continue;
      const message = reply.success;
      if (!message.authoritative || message.recursionDesired || (message.rcode !== 0 && message.rcode !== 3)) continue;
      if (aliased(message)) return yield* lookupError("ECNAME", `"${name}" is a CNAME; the TXT record must be at that name itself.`);
      if (message.rcode === 3) return [];
      return message.answers.flatMap(record => record.name === name && record.data.type === "TXT" ? [record.data.strings] : []);
    }
    return yield* lookupError("ESERVFAIL", `No authoritative nameserver of "${apex}" answered for "${name}".`);
  });

  const aborted = (signal: AbortSignal) => Effect.callback<never, DnsLookupError>(resume => {
    const stop = () => resume(Effect.fail(lookupError("ETIMEOUT", "The DNS lookup was cancelled.")));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", stop));
  });

  const run = <A>(program: Effect.Effect<A, DnsLookupError>, signal?: AbortSignal) =>
    present(signal ? Effect.raceFirst(program, aborted(signal)) : program);
  const normalized = (host: string) => host.toLowerCase().replace(/\.$/, "");
  return {
    resolveTxt: (host, signal) => run(lookup(normalized(host), false).pipe(Effect.map(answers => answers as readonly (readonly string[])[])), signal),
    /** For DNS-01: every authoritative server must answer, and each answer is returned on its own. */
    txtAtEveryAuthority: (host, signal) => run(lookup(normalized(host), true).pipe(
      Effect.map(answers => answers as readonly (readonly (readonly string[])[])[])), signal),
  };
}
