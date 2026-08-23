import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type EditorConfig,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import * as React from "react";

export interface SerializedFileCardNode {
  type: "zelavis-file-card";
  version: 1;
  href: string;
  label: string;
  meta?: string;
}

function convertFileCardElement(domNode: Node): DOMConversionOutput | null {
  if (!(domNode instanceof HTMLElement)) {
    return null;
  }

  if (domNode.dataset.zelavisFileCard !== "true") {
    return null;
  }

  return {
    node: $createFileCardNode({
      href: domNode.dataset.href ?? "#",
      label: domNode.dataset.label ?? "File",
      meta: domNode.dataset.meta ?? "",
    }),
  };
}

export class FileCardNode extends DecoratorNode<React.JSX.Element> {
  __href: string;
  __label: string;
  __meta: string;

  static getType(): string {
    return "zelavis-file-card";
  }

  static clone(node: FileCardNode): FileCardNode {
    return new FileCardNode(node.__href, node.__label, node.__meta, node.__key);
  }

  static importJSON(
    serializedNode: SerializedLexicalNode & Record<string, unknown>,
  ): FileCardNode {
    return $createFileCardNode({
      href: typeof serializedNode.href === "string" ? serializedNode.href : "#",
      label:
        typeof serializedNode.label === "string" ? serializedNode.label : "File",
      meta: typeof serializedNode.meta === "string" ? serializedNode.meta : "",
    });
  }

  static importDOM(): DOMConversionMap | null {
    return {
      a: () => ({
        conversion: convertFileCardElement,
        priority: 2,
      }),
    };
  }

  constructor(href: string, label: string, meta: string, key?: NodeKey) {
    super(key);
    this.__href = href;
    this.__label = label;
    this.__meta = meta;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("a");
    element.href = this.__href;
    element.dataset.zelavisFileCard = "true";
    element.dataset.href = this.__href;
    element.dataset.label = this.__label;
    element.dataset.meta = this.__meta;
    element.className =
      "my-4 flex rounded-md border bg-muted/15 px-4 py-3 no-underline";

    const content = document.createElement("div");

    const title = document.createElement("p");
    title.textContent = this.__label;
    title.className = "font-medium";
    content.appendChild(title);

    if (this.__meta) {
      const meta = document.createElement("p");
      meta.textContent = this.__meta;
      meta.className = "text-sm";
      content.appendChild(meta);
    }

    element.appendChild(content);
    return { element };
  }

  exportJSON(): SerializedFileCardNode {
    return {
      type: "zelavis-file-card",
      version: 1,
      href: this.__href,
      label: this.__label,
      meta: this.__meta || undefined,
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "block";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): React.JSX.Element {
    return (
      <a
        href={this.__href}
        target="_blank"
        rel="noreferrer"
        className="my-4 flex rounded-md border bg-muted/15 px-4 py-3 no-underline transition-colors hover:bg-accent"
      >
        <div className="grid gap-1">
          <p className="font-medium text-foreground">{this.__label}</p>
          {this.__meta ? (
            <p className="text-sm text-muted-foreground">{this.__meta}</p>
          ) : null}
        </div>
      </a>
    );
  }
}

export function $createFileCardNode(input: {
  href: string;
  label: string;
  meta?: string;
}): FileCardNode {
  return $applyNodeReplacement(
    new FileCardNode(input.href, input.label, input.meta ?? ""),
  );
}

export function $isFileCardNode(
  node: LexicalNode | null | undefined,
): node is FileCardNode {
  return node instanceof FileCardNode;
}
