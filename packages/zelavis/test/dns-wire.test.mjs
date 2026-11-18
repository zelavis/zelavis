import assert from "node:assert/strict";
import test from "node:test";
import { decodeDnsMessage, DnsWireError, encodeDnsQuery, encodeDnsResponse } from "../dist/edge/dns-wire.js";

const response = (overrides = {}) => ({
  id: 4242, response: true, authoritative: true, truncated: false, recursionDesired: false, rcode: 0,
  questions: [{ name: "_zelavis-challenge.shop.example.com", type: "TXT" }], answers: [], authority: [], ...overrides,
});

test("a response with every supported record type round-trips, names lowercased", () => {
  const message = response({
    questions: [{ name: "Shop.Example.COM", type: "A" }],
    answers: [
      { name: "Shop.Example.com", ttl: 60, data: { type: "A", address: "192.0.2.10" } },
      { name: "shop.example.com", ttl: 60, data: { type: "AAAA", address: "2001:db8::1" } },
      { name: "shop.example.com", ttl: 60, data: { type: "AAAA", address: "2001:db8:1:2:3:4:5:6" } },
      { name: "example.com", ttl: 300, data: { type: "NS", target: "NS1.example.net" } },
      { name: "www.example.com", ttl: 30, data: { type: "CNAME", target: "ingress.host.net" } },
      { name: "_zelavis-challenge.shop.example.com", ttl: 5, data: { type: "TXT", strings: ["part one", "x".repeat(255), ""] } },
    ],
    authority: [{ name: "example.com", ttl: 900, data: { type: "SOA", primary: "ns1.example.net" } }],
    rcode: 3, truncated: true, recursionDesired: true, authoritative: false,
  });
  const lower = name => name.toLowerCase();
  const expected = {
    ...message,
    questions: message.questions.map(question => ({ ...question, name: lower(question.name) })),
    answers: message.answers.map(record => ({
      ...record, name: lower(record.name),
      data: "target" in record.data ? { ...record.data, target: lower(record.data.target) } : record.data,
    })),
  };
  assert.deepEqual(decodeDnsMessage(encodeDnsResponse(message)), expected);
});

test("IPv6 addresses decode in RFC 5952 form", () => {
  const decoded = decodeDnsMessage(encodeDnsResponse(response({
    answers: ["0:0:0:0:0:0:0:1", "2001:DB8:0:0:1:0:0:1", "2001:db8:0:1:1:1:1:1", "::"].map(address =>
      ({ name: "a.example.com", ttl: 1, data: { type: "AAAA", address } })),
  })));
  assert.deepEqual(decoded.answers.map(record => record.data.address), ["::1", "2001:db8::1:0:0:1", "2001:db8:0:1:1:1:1:1", "::"]);
});

test("a query asks one question with recursion as requested", () => {
  for (const recursionDesired of [true, false]) {
    const decoded = decodeDnsMessage(encodeDnsQuery(7, { name: "example.com", type: "SOA" }, recursionDesired));
    assert.equal(decoded.id, 7);
    assert.equal(decoded.response, false);
    assert.equal(decoded.recursionDesired, recursionDesired);
    assert.deepEqual(decoded.questions, [{ name: "example.com", type: "SOA" }]);
    assert.deepEqual([decoded.answers, decoded.authority], [[], []]);
  }
  assert.throws(() => encodeDnsQuery(70_000, { name: "example.com", type: "TXT" }, false), DnsWireError);
  assert.throws(() => encodeDnsQuery(1, { name: "a..example.com", type: "TXT" }, false), DnsWireError);
  assert.throws(() => encodeDnsQuery(1, { name: `${"a".repeat(64)}.example.com`, type: "TXT" }, false), DnsWireError);
});

const header = (answers) => [0x12, 0x34, 0x84, 0x00, 0, 1, 0, answers, 0, 0, 0, 0];
const label = text => [text.length, ...Array.from(text, char => char.charCodeAt(0))];

test("compression pointers decode, and loops, long names and truncation are refused", () => {
  // Question "a.example.com" at offset 12; the answer's name and CNAME target point back into it.
  const question = [...label("a"), ...label("example"), ...label("com"), 0, 0, 5, 0, 1];
  const target = [...label("b"), 0xc0, 14];
  const answer = [0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, target.length, ...target];
  const decoded = decodeDnsMessage(Uint8Array.from([...header(1), ...question, ...answer]));
  assert.deepEqual(decoded.questions, [{ name: "a.example.com", type: "CNAME" }]);
  assert.deepEqual(decoded.answers, [{ name: "a.example.com", ttl: 60, data: { type: "CNAME", target: "b.example.com" } }]);
  assert.equal(decoded.authoritative, true);

  const loop = Uint8Array.from([...header(0).slice(0, 5), 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1]);
  assert.throws(() => decodeDnsMessage(loop), DnsWireError);

  const long = [];
  for (let index = 0; index < 5; index++) long.push(...label("x".repeat(63)));
  const tooLong = Uint8Array.from([...header(0).slice(0, 5), 1, 0, 0, 0, 0, 0, 0, ...long, 0, 0, 1, 0, 1]);
  assert.throws(() => decodeDnsMessage(tooLong), /longer than 255/);

  const whole = encodeDnsResponse(response({ answers: [{ name: "x.example.com", ttl: 1, data: { type: "TXT", strings: ["token"] } }] }));
  for (const length of [0, 11, 20, whole.length - 1]) {
    assert.throws(() => decodeDnsMessage(whole.subarray(0, length)), DnsWireError, String(length));
  }
  assert.throws(() => decodeDnsMessage(new Uint8Array(65_536)), DnsWireError);
});

test("unknown record types decode as OTHER and oversized sections are refused", () => {
  const question = [...label("example"), ...label("com"), 0, 0, 16, 0, 1];
  const other = [0xc0, 12, 0, 99, 0, 1, 0, 0, 0, 1, 0, 3, 1, 2, 3];
  const decoded = decodeDnsMessage(Uint8Array.from([...header(1), ...question, ...other]));
  assert.deepEqual(decoded.answers, [{ name: "example.com", ttl: 1, data: { type: "OTHER", code: 99 } }]);
  const crowded = Uint8Array.from([0, 0, 0x80, 0, 0, 0, 0x01, 0x01, 0, 0, 0, 0]);
  assert.throws(() => decodeDnsMessage(crowded), /more than 256/);
  const wrongLength = [0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 1, 0, 3, 1, 2, 3];
  assert.throws(() => decodeDnsMessage(Uint8Array.from([...header(1), ...question, ...wrongLength])), /4 bytes/);
});
