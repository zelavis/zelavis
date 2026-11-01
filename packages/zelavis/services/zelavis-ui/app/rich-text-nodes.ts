import { $applyNodeReplacement, DecoratorNode, type DOMConversionMap, type DOMConversionOutput, type DOMExportOutput, type LexicalNode, type NodeKey, type SerializedLexicalNode } from "lexical";

/**
 * The three blocks the rich text editor adds to Lexical's own: an image, a callout and a file card. They draw themselves
 * (`createDOM` builds the whole block) and export the same HTML the original editor stored, so content written by either reads in both.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => { const node = document.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };

export class ImageNode extends DecoratorNode<null> {
  __src: string;
  __altText: string;
  static getType() { return "zelavis-image"; }
  static clone(node: ImageNode) { return new ImageNode(node.__src, node.__altText, node.__key); }
  static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>) { return $createImageNode({ src: typeof serialized.src === "string" ? serialized.src : "", altText: typeof serialized.altText === "string" ? serialized.altText : "" }); }
  static importDOM(): DOMConversionMap | null {
    return { img: () => ({ conversion: (dom: Node): DOMConversionOutput | null => dom instanceof HTMLImageElement ? { node: $createImageNode({ src: dom.src, altText: dom.alt }) } : null, priority: 2 }) };
  }
  constructor(src: string, altText = "", key?: NodeKey) { super(key); this.__src = src; this.__altText = altText; }
  exportDOM(): DOMExportOutput { const element = document.createElement("img"); element.setAttribute("src", this.__src); element.setAttribute("alt", this.__altText); element.setAttribute("loading", "lazy"); return { element }; }
  exportJSON() { return { type: "zelavis-image", version: 1, src: this.__src, altText: this.__altText }; }
  createDOM() {
    const wrapper = el("span", "rte-block");
    const image = el("img", "rte-image");
    image.src = this.__src; image.alt = this.__altText;
    wrapper.append(image);
    return wrapper;
  }
  updateDOM() { return false; }
  decorate() { return null; }
}
export const $createImageNode = (input: { src: string; altText?: string }) => $applyNodeReplacement(new ImageNode(input.src, input.altText ?? ""));
export const $isImageNode = (node: LexicalNode | null | undefined): node is ImageNode => node instanceof ImageNode;

export class CalloutNode extends DecoratorNode<null> {
  __title: string;
  __body: string;
  static getType() { return "zelavis-callout"; }
  static clone(node: CalloutNode) { return new CalloutNode(node.__title, node.__body, node.__key); }
  static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>) { return $createCalloutNode({ title: typeof serialized.title === "string" ? serialized.title : "Callout", body: typeof serialized.body === "string" ? serialized.body : "" }); }
  static importDOM(): DOMConversionMap | null {
    return { div: () => ({ conversion: (dom: Node): DOMConversionOutput | null => dom instanceof HTMLElement && dom.dataset.zelavisCallout === "true" ? { node: $createCalloutNode({ title: dom.dataset.title ?? "Callout", body: dom.dataset.body ?? dom.textContent ?? "" }) } : null, priority: 2 }) };
  }
  constructor(title: string, body: string, key?: NodeKey) { super(key); this.__title = title; this.__body = body; }
  exportDOM(): DOMExportOutput {
    const element = el("div", "my-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3");
    element.dataset.zelavisCallout = "true"; element.dataset.title = this.__title; element.dataset.body = this.__body;
    element.append(el("p", "font-medium", this.__title), el("p", "mt-1", this.__body));
    return { element };
  }
  exportJSON() { return { type: "zelavis-callout", version: 1, title: this.__title, body: this.__body }; }
  createDOM() { const wrapper = el("span", "rte-block"); const box = el("div", "rte-callout"); box.append(el("p", "rte-callout-title", this.__title), el("p", "rte-callout-body", this.__body)); wrapper.append(box); return wrapper; }
  updateDOM() { return false; }
  decorate() { return null; }
}
export const $createCalloutNode = (input: { title: string; body: string }) => $applyNodeReplacement(new CalloutNode(input.title, input.body));

export class FileCardNode extends DecoratorNode<null> {
  __href: string;
  __label: string;
  __meta: string;
  static getType() { return "zelavis-file-card"; }
  static clone(node: FileCardNode) { return new FileCardNode(node.__href, node.__label, node.__meta, node.__key); }
  static importJSON(serialized: SerializedLexicalNode & Record<string, unknown>) { return $createFileCardNode({ href: typeof serialized.href === "string" ? serialized.href : "#", label: typeof serialized.label === "string" ? serialized.label : "File", meta: typeof serialized.meta === "string" ? serialized.meta : "" }); }
  static importDOM(): DOMConversionMap | null {
    return { a: () => ({ conversion: (dom: Node): DOMConversionOutput | null => dom instanceof HTMLElement && dom.dataset.zelavisFileCard === "true" ? { node: $createFileCardNode({ href: dom.dataset.href ?? "#", label: dom.dataset.label ?? "File", meta: dom.dataset.meta ?? "" }) } : null, priority: 2 }) };
  }
  constructor(href: string, label: string, meta: string, key?: NodeKey) { super(key); this.__href = href; this.__label = label; this.__meta = meta; }
  exportDOM(): DOMExportOutput {
    const element = el("a", "my-4 flex rounded-md border bg-muted/15 px-4 py-3 no-underline");
    element.href = this.__href; element.dataset.zelavisFileCard = "true"; element.dataset.href = this.__href; element.dataset.label = this.__label; element.dataset.meta = this.__meta;
    const content = document.createElement("div");
    content.append(el("p", "font-medium", this.__label));
    if (this.__meta) content.append(el("p", "text-sm", this.__meta));
    element.append(content);
    return { element };
  }
  exportJSON() { return { type: "zelavis-file-card", version: 1, href: this.__href, label: this.__label, meta: this.__meta || undefined }; }
  createDOM() { const wrapper = el("span", "rte-block"); const link = el("a", "rte-file"); link.href = this.__href; link.target = "_blank"; link.rel = "noreferrer"; link.append(el("strong", "", this.__label)); if (this.__meta) link.append(el("small", "", this.__meta)); wrapper.append(link); return wrapper; }
  updateDOM() { return false; }
  decorate() { return null; }
}
export const $createFileCardNode = (input: { href: string; label: string; meta?: string }) => $applyNodeReplacement(new FileCardNode(input.href, input.label, input.meta ?? ""));
