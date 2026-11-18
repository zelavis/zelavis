/**
 * DNS message encoding and decoding (RFC 1035), just enough to ask a zone's authoritative servers for a TXT record
 * and read the flags that say whether the answer is authoritative. Pure: no host APIs, no imports. The transport lives
 * in `adapters/_node-authoritative-dns.ts`.
 *
 * Every bound is checked before anything is copied: input of at most 65535 bytes, labels of 1-63 bytes, names of at
 * most 255 bytes on the wire, at most 64 compression pointers per name and at most 256 records per section. Names are
 * lowercase ASCII without a trailing dot; the root is the empty string. TXT character-strings decode as Latin-1.
 */

export type DnsRecordType = "A" | "AAAA" | "NS" | "CNAME" | "SOA" | "TXT";
export const DNS_TYPE: Readonly<Record<DnsRecordType, number>> = { A: 1, NS: 2, CNAME: 5, SOA: 6, TXT: 16, AAAA: 28 };
export interface DnsQuestion { readonly name: string; readonly type: DnsRecordType }
export type DnsRecordData =
  | { readonly type: "A" | "AAAA"; readonly address: string }
  | { readonly type: "NS" | "CNAME"; readonly target: string }
  | { readonly type: "SOA"; readonly primary: string }
  | { readonly type: "TXT"; readonly strings: readonly string[] }
  | { readonly type: "OTHER"; readonly code: number };
export interface DnsRecord { readonly name: string; readonly ttl: number; readonly data: DnsRecordData }
export interface DnsMessage {
  readonly id: number;
  readonly response: boolean;
  readonly authoritative: boolean;
  readonly truncated: boolean;
  readonly recursionDesired: boolean;
  readonly rcode: number; // 0 NOERROR, 2 SERVFAIL, 3 NXDOMAIN, 5 REFUSED
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly DnsRecord[];
  readonly authority: readonly DnsRecord[];
}

export class DnsWireError extends Error {
  readonly _tag = "DnsWireError";
}

const MAX_MESSAGE = 65_535;
const MAX_NAME = 255;
const MAX_LABEL = 63;
const MAX_POINTERS = 64;
const MAX_RECORDS = 256;
const CLASS_IN = 1;
const HEADER = 12;
const typeNames = new Map<number, DnsRecordType>(Object.entries(DNS_TYPE).map(([name, code]) => [code, name as DnsRecordType]));

const QR = 0x8000;
const AA = 0x0400;
const TC = 0x0200;
const RD = 0x0100;

class Writer {
  private readonly bytes: number[] = [];
  u8(value: number) { this.bytes.push(value & 0xff); }
  u16(value: number) { this.u8(value >>> 8); this.u8(value); }
  u32(value: number) { this.u16(value >>> 16); this.u16(value); }
  raw(values: Iterable<number>) { for (const value of values) this.u8(value); }
  get length() { return this.bytes.length; }
  patch16(at: number, value: number) { this.bytes[at] = (value >>> 8) & 0xff; this.bytes[at + 1] = value & 0xff; }
  finish(): Uint8Array {
    if (this.bytes.length > MAX_MESSAGE) throw new DnsWireError("The DNS message is longer than 65535 bytes.");
    return Uint8Array.from(this.bytes);
  }
}

function writeName(writer: Writer, name: string): void {
  const labels = name === "" ? [] : name.toLowerCase().split(".");
  let length = 1;
  for (const label of labels) {
    if (label.length < 1 || label.length > MAX_LABEL || !/^[\x21-\x7e]+$/.test(label)) {
      throw new DnsWireError(`Invalid DNS label in "${name}".`);
    }
    length += label.length + 1;
  }
  if (length > MAX_NAME) throw new DnsWireError(`The DNS name "${name}" is longer than 255 bytes.`);
  for (const label of labels) {
    writer.u8(label.length);
    for (let index = 0; index < label.length; index++) writer.u8(label.charCodeAt(index));
  }
  writer.u8(0);
}

function writeHeader(writer: Writer, id: number, flags: number, counts: readonly number[]): void {
  if (!Number.isInteger(id) || id < 0 || id > 0xffff) throw new DnsWireError("A DNS message id is a 16-bit integer.");
  writer.u16(id);
  writer.u16(flags);
  for (const count of counts) {
    if (count > MAX_RECORDS) throw new DnsWireError("A DNS section holds at most 256 entries here.");
    writer.u16(count);
  }
}

function writeQuestion(writer: Writer, question: DnsQuestion): void {
  writeName(writer, question.name);
  writer.u16(DNS_TYPE[question.type]);
  writer.u16(CLASS_IN);
}

export function encodeDnsQuery(id: number, question: DnsQuestion, recursionDesired: boolean): Uint8Array {
  const writer = new Writer();
  writeHeader(writer, id, recursionDesired ? RD : 0, [1, 0, 0, 0]);
  writeQuestion(writer, question);
  return writer.finish();
}

function ipv4Bytes(address: string): number[] {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every(part => /^(?:0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)) {
    throw new DnsWireError(`Invalid IPv4 address "${address}".`);
  }
  return parts.map(Number);
}

function ipv6Bytes(address: string): number[] {
  const halves = address.toLowerCase().split("::");
  if (halves.length > 2) throw new DnsWireError(`Invalid IPv6 address "${address}".`);
  const groups = (part: string) => part === "" ? [] : part.split(":");
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) throw new DnsWireError(`Invalid IPv6 address "${address}".`);
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (!all.every(group => /^[0-9a-f]{1,4}$/.test(group))) throw new DnsWireError(`Invalid IPv6 address "${address}".`);
  return all.flatMap(group => { const value = parseInt(group, 16); return [value >>> 8, value & 0xff]; });
}

/** RFC 5952 text: lowercase, no leading zeros, the longest run of two or more zero groups as `::`. */
function ipv6Text(bytes: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, index) => (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!);
  let bestStart = -1, bestLength = 0;
  for (let index = 0; index < 8;) {
    if (groups[index] !== 0) { index++; continue; }
    let end = index;
    while (end < 8 && groups[end] === 0) end++;
    if (end - index > bestLength) { bestStart = index; bestLength = end - index; }
    index = end;
  }
  const text = (values: number[]) => values.map(value => value.toString(16)).join(":");
  if (bestLength < 2) return text(groups);
  return `${text(groups.slice(0, bestStart))}::${text(groups.slice(bestStart + bestLength))}`;
}

function writeRecord(writer: Writer, record: DnsRecord): void {
  const { data } = record;
  if (data.type === "OTHER") throw new DnsWireError("A record of an unsupported type cannot be encoded.");
  writeName(writer, record.name);
  writer.u16(DNS_TYPE[data.type]);
  writer.u16(CLASS_IN);
  if (!Number.isInteger(record.ttl) || record.ttl < 0 || record.ttl > 0x7fffffff) throw new DnsWireError("Invalid DNS TTL.");
  writer.u32(record.ttl);
  const lengthAt = writer.length;
  writer.u16(0);
  const start = writer.length;
  switch (data.type) {
    case "A": writer.raw(ipv4Bytes(data.address)); break;
    case "AAAA": writer.raw(ipv6Bytes(data.address)); break;
    case "NS": case "CNAME": writeName(writer, data.target); break;
    case "SOA":
      // The fixture's SOA: the primary server, the root as the mailbox, and fixed timers with the TTL as minimum.
      writeName(writer, data.primary);
      writeName(writer, "");
      for (const value of [1, 3600, 600, 86_400, record.ttl]) writer.u32(value);
      break;
    case "TXT":
      if (data.strings.length === 0) throw new DnsWireError("A TXT record holds at least one character-string.");
      for (const text of data.strings) {
        if (text.length > 255 || !/^[\x00-\xff]*$/.test(text)) throw new DnsWireError("A TXT character-string is at most 255 Latin-1 bytes.");
        writer.u8(text.length);
        for (let index = 0; index < text.length; index++) writer.u8(text.charCodeAt(index));
      }
      break;
  }
  const length = writer.length - start;
  if (length > 0xffff) throw new DnsWireError("DNS record data is longer than 65535 bytes.");
  writer.patch16(lengthAt, length);
}

/** Test fixtures and the qualification harness use this to answer queries. */
export function encodeDnsResponse(message: DnsMessage): Uint8Array {
  if (!Number.isInteger(message.rcode) || message.rcode < 0 || message.rcode > 15) throw new DnsWireError("Invalid DNS response code.");
  const flags = (message.response ? QR : 0) | (message.authoritative ? AA : 0) | (message.truncated ? TC : 0) |
    (message.recursionDesired ? RD : 0) | message.rcode;
  const writer = new Writer();
  writeHeader(writer, message.id, flags, [message.questions.length, message.answers.length, message.authority.length, 0]);
  for (const question of message.questions) writeQuestion(writer, question);
  for (const record of message.answers) writeRecord(writer, record);
  for (const record of message.authority) writeRecord(writer, record);
  return writer.finish();
}

class Reader {
  readonly view: DataView;
  offset = HEADER;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  need(count: number, at = this.offset) {
    if (at + count > this.bytes.length) throw new DnsWireError("The DNS message ends early.");
  }
  u16() { this.need(2); const value = this.view.getUint16(this.offset); this.offset += 2; return value; }
  u32() { this.need(4); const value = this.view.getUint32(this.offset); this.offset += 4; return value; }

  /** Read a name at `this.offset`, following compression pointers, and move past its in-place bytes. */
  name(): string {
    const labels: string[] = [];
    let at = this.offset, jumps = 0, wire = 1, resume: number | undefined;
    for (;;) {
      this.need(1, at);
      const length = this.bytes[at]!;
      if ((length & 0xc0) === 0xc0) {
        this.need(2, at);
        if (++jumps > MAX_POINTERS) throw new DnsWireError("A DNS name follows too many compression pointers.");
        resume ??= at + 2;
        at = ((length & 0x3f) << 8) | this.bytes[at + 1]!;
        if (at >= this.bytes.length) throw new DnsWireError("A DNS compression pointer points outside the message.");
        continue;
      }
      if ((length & 0xc0) !== 0) throw new DnsWireError("A DNS label uses an unsupported extended type.");
      if (length === 0) { at += 1; break; }
      wire += length + 1;
      if (wire > MAX_NAME) throw new DnsWireError("A DNS name is longer than 255 bytes.");
      this.need(length + 1, at);
      let label = "";
      for (let index = at + 1; index <= at + length; index++) label += String.fromCharCode(this.bytes[index]!);
      labels.push(label.toLowerCase());
      at += length + 1;
    }
    this.offset = resume ?? at;
    return labels.join(".");
  }

  question(): DnsQuestion | undefined {
    const name = this.name();
    const code = this.u16();
    this.u16(); // class
    const type = typeNames.get(code);
    return type ? { name, type } : undefined;
  }

  record(): DnsRecord {
    const name = this.name();
    const code = this.u16();
    this.u16(); // class
    const ttl = this.u32() & 0x7fffffff;
    const length = this.u16();
    this.need(length);
    const start = this.offset, end = start + length;
    const exact = <A>(value: A): A => {
      if (this.offset !== end) throw new DnsWireError("DNS record data does not match its length.");
      return value;
    };
    const type = typeNames.get(code);
    switch (type) {
      case "A":
        if (length !== 4) throw new DnsWireError("An A record holds 4 bytes.");
        this.offset = end;
        return { name, ttl, data: { type, address: Array.from(this.bytes.subarray(start, end)).join(".") } };
      case "AAAA":
        if (length !== 16) throw new DnsWireError("An AAAA record holds 16 bytes.");
        this.offset = end;
        return { name, ttl, data: { type, address: ipv6Text(this.bytes.subarray(start, end)) } };
      case "NS": case "CNAME":
        return exact({ name, ttl, data: { type, target: this.name() } });
      case "SOA": {
        const primary = this.name();
        this.name(); // mailbox
        this.need(20);
        this.offset += 20;
        return exact({ name, ttl, data: { type, primary } });
      }
      case "TXT": {
        const strings: string[] = [];
        if (length === 0) throw new DnsWireError("A TXT record holds at least one character-string.");
        while (this.offset < end) {
          const size = this.bytes[this.offset]!;
          if (this.offset + 1 + size > end) throw new DnsWireError("A TXT character-string overruns its record.");
          let text = "";
          for (let index = this.offset + 1; index <= this.offset + size; index++) text += String.fromCharCode(this.bytes[index]!);
          strings.push(text);
          this.offset += 1 + size;
        }
        return { name, ttl, data: { type, strings } };
      }
      default:
        this.offset = end;
        return { name, ttl, data: { type: "OTHER", code } };
    }
  }
}

/** Throws DnsWireError on malformed input or a bound being exceeded. The additional section is not read. */
export function decodeDnsMessage(bytes: Uint8Array): DnsMessage {
  if (bytes.length > MAX_MESSAGE) throw new DnsWireError("The DNS message is longer than 65535 bytes.");
  if (bytes.length < HEADER) throw new DnsWireError("The DNS message ends early.");
  const reader = new Reader(bytes);
  const id = reader.view.getUint16(0), flags = reader.view.getUint16(2);
  const counts = [4, 6, 8].map(at => reader.view.getUint16(at));
  if (counts.some(count => count > MAX_RECORDS)) throw new DnsWireError("A DNS section holds more than 256 entries.");
  const questions: DnsQuestion[] = [];
  for (let index = 0; index < counts[0]!; index++) {
    const question = reader.question();
    if (!question) throw new DnsWireError("A DNS question asks for an unsupported type.");
    questions.push(question);
  }
  const answers = Array.from({ length: counts[1]! }, () => reader.record());
  const authority = Array.from({ length: counts[2]! }, () => reader.record());
  return {
    id,
    response: (flags & QR) !== 0,
    authoritative: (flags & AA) !== 0,
    truncated: (flags & TC) !== 0,
    recursionDesired: (flags & RD) !== 0,
    rcode: flags & 0x0f,
    questions,
    answers,
    authority,
  };
}
