/**
 * Components for service pages that did not ask for them.
 *
 * A service page is plain HTML in its own document. When the installed frontend supplies a component runtime
 * (`serviceUi`), the Platform adds a stylesheet and a module to each HTML page it serves, so the page can write
 * `<zv-select>` and have it work with no build step of its own. A page that brings its own components opts out with
 * `<meta name="zelavis-service-ui" content="none">`.
 */

const optOut = /<meta\b[^>]*\bname\s*=\s*["']?zelavis-service-ui["']?[^>]*\bcontent\s*=\s*["']?none["']?/i;
const marker = "data-zelavis-service-ui";

export interface ServiceUiLinks {
  readonly stylesheet: string;
  readonly script: string;
}

/** The page with the component stylesheet and runtime at the top of its head; unchanged when it opts out or already has them. */
export function injectServiceUi(html: string, links: ServiceUiLinks): string {
  if (optOut.test(html) || html.includes(marker)) return html;
  const tags = `<link rel="stylesheet" href="${links.stylesheet}" ${marker}><script type="module" src="${links.script}" ${marker}></script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}${tags}${html.slice(head.index + head[0].length)}`;
  const root = /<html\b[^>]*>/i.exec(html);
  if (root) return `${html.slice(0, root.index + root[0].length)}<head>${tags}</head>${html.slice(root.index + root[0].length)}`;
  return `${tags}${html}`;
}

/** A short revision of an asset's text, for its ETag: the same text always names the same revision. */
export function serviceUiRevision(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}
