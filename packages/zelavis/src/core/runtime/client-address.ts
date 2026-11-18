/**
 * The network address of the caller, as a request fact.
 *
 * Adapters that know the transport attach it (the Node listener from the peer
 * or Zelavis's own ingress, a Project runtime from its verified Gateway
 * envelope); core only carries it. It is held beside the `Request` rather than
 * in a module-level "current request", so concurrent requests never share it.
 */
const addresses = new WeakMap<Request, string>();

/** Records the caller's address for this request; `undefined` or an invalid literal leaves it unknown. */
export function setRequestClientAddress(request: Request, address: string | undefined): void {
  const normalized = address === undefined ? undefined : normalizeClientAddress(address);
  if (normalized === undefined) addresses.delete(request);
  else addresses.set(request, normalized);
}

/** The caller's address for this request, or `undefined` when no trusted source supplied one. */
export function requestClientAddress(request: Request): string | undefined {
  return addresses.get(request);
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/u;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/u;

function validIpv6(value: string): boolean {
  if (value.length > 45 || !/^[0-9a-fA-F:.]+$/u.test(value)) return false;
  const doubled = value.indexOf("::");
  if (doubled !== value.lastIndexOf("::")) return false;
  let groups = value.split(":");
  let width = 8;
  const last = groups[groups.length - 1] ?? "";
  if (last.includes(".")) {
    if (!IPV4.test(last)) return false;
    groups = [...groups.slice(0, -1), "0", "0"];
  }
  if (doubled === -1) return groups.length === width && groups.every((group) => HEX_GROUP.test(group));
  // `::` stands for at least one group of zeros; the text around it may start or end with an empty piece.
  const [head = "", tail = ""] = value.split("::");
  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === "" ? [] : tail.split(":");
  const tailCount = tailGroups.length + (tailGroups[tailGroups.length - 1]?.includes(".") ? 1 : 0);
  width -= headGroups.length + tailCount;
  return width >= 1 && headGroups.every((group) => HEX_GROUP.test(group)) &&
    tailGroups.every((group, index) => group.includes(".") && index === tailGroups.length - 1 ? IPV4.test(group) : HEX_GROUP.test(group));
}

/**
 * A valid IPv4 or IPv6 literal in the form Node reports it, or `undefined`.
 * `::ffff:a.b.c.d` becomes `a.b.c.d` and a zone (`%eth0`) is dropped.
 */
export function normalizeClientAddress(value: string): string | undefined {
  const trimmed = value.trim();
  const zone = trimmed.indexOf("%");
  const text = zone === -1 ? trimmed : trimmed.slice(0, zone);
  if (text === "") return undefined;
  if (IPV4.test(text)) return text;
  if (!text.includes(":") || !validIpv6(text)) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(text);
  if (mapped?.[1] !== undefined && IPV4.test(mapped[1])) return mapped[1];
  return text;
}
