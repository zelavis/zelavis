/** Small, bounded XML subset for registrar responses. No DTD, numeric/custom entities, CDATA or expansion. */
export interface XmlElement { readonly name: string; readonly attributes: Readonly<Record<string, string>>; readonly children: readonly XmlElement[]; readonly text: string }
const entities: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const invalid = () => new TypeError("The registrar returned malformed or unsupported XML.");
function decode(text: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos);)/u.test(text)) throw invalid();
  return text.replace(/&(amp|lt|gt|quot|apos);/gu, (_, name: string) => entities[name]!);
}
export function parseXmlResponse(raw: string): XmlElement {
  if (new TextEncoder().encode(raw).length > 1_048_576 || /<!/u.test(raw)) throw invalid();
  const source = raw.replace(/^\uFEFF?\s*<\?xml\s+[^?]*\?>/u, "");
  type Mutable = { name: string; attributes: Record<string, string>; children: Mutable[]; text: string };
  const stack: Mutable[] = [];
  let root: Mutable | undefined;
  let offset = 0;
  let count = 0;
  const tokens = /<[^>]*>|[^<]+/guy;
  for (const match of source.matchAll(tokens)) {
    if (match.index !== offset || ++count > 50_000) throw invalid();
    const token = match[0]; offset += token.length;
    if (!token.startsWith("<")) {
      if (stack.length) stack[stack.length - 1]!.text += decode(token);
      else if (token.trim()) throw invalid();
      continue;
    }
    if (token.startsWith("</")) {
      if (!/^<\/[A-Za-z_][\w.:-]*\s*>$/u.test(token) || stack.pop()?.name !== token.slice(2, -1).trim()) throw invalid();
      continue;
    }
    const opening = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<>]*"|'[^'<>]*'))*)\s*(\/?)>$/u.exec(token);
    if (!opening || stack.length >= 32) throw invalid();
    const element: Mutable = { name: opening[1]!, attributes: Object.create(null), children: [], text: "" };
    for (const attr of opening[2]!.matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)')/gu)) {
      if (Object.hasOwn(element.attributes, attr[1]!)) throw invalid();
      element.attributes[attr[1]!] = decode(attr[2] ?? attr[3] ?? "");
    }
    if (stack.length) stack[stack.length - 1]!.children.push(element);
    else { if (root) throw invalid(); root = element; }
    if (!opening[3]) stack.push(element);
  }
  if (offset !== source.length || stack.length || !root) throw invalid();
  return root;
}
export function xmlChild(element: XmlElement, name: string): XmlElement {
  const matches = element.children.filter(child => child.name === name);
  if (matches.length !== 1) throw invalid();
  return matches[0]!;
}
