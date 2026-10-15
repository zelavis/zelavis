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

export interface SerializedImageNode {
  type: "zelavis-image";
  version: 1;
  src: string;
  altText: string;
}

function convertImageElement(domNode: Node): DOMConversionOutput | null {
  if (!(domNode instanceof HTMLImageElement)) {
    return null;
  }

  return {
    node: $createImageNode({
      src: domNode.src,
      altText: domNode.alt,
    }),
  };
}

export class ImageNode extends DecoratorNode<React.JSX.Element> {
  __src: string;
  __altText: string;

  static getType(): string {
    return "zelavis-image";
  }

  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__src, node.__altText, node.__key);
  }

  static importJSON(
    serializedNode: SerializedLexicalNode & Record<string, unknown>,
  ): ImageNode {
    return $createImageNode({
      src: typeof serializedNode.src === "string" ? serializedNode.src : "",
      altText:
        typeof serializedNode.altText === "string"
          ? serializedNode.altText
          : "",
    });
  }

  static importDOM(): DOMConversionMap | null {
    return {
      img: () => ({
        conversion: convertImageElement,
        priority: 2,
      }),
    };
  }

  constructor(src: string, altText = "", key?: NodeKey) {
    super(key);
    this.__src = src;
    this.__altText = altText;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("img");
    element.setAttribute("src", this.__src);
    element.setAttribute("alt", this.__altText);
    element.setAttribute("loading", "lazy");
    return { element };
  }

  exportJSON(): SerializedImageNode {
    return {
      type: "zelavis-image",
      version: 1,
      src: this.__src,
      altText: this.__altText,
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement("span");
    span.className = "inline-block w-full";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): React.JSX.Element {
    return (
      <img
        src={this.__src}
        alt={this.__altText}
        className="my-4 max-h-96 w-full rounded-md border object-contain"
      />
    );
  }
}

export function $createImageNode(input: {
  src: string;
  altText?: string;
}): ImageNode {
  return $applyNodeReplacement(new ImageNode(input.src, input.altText ?? ""));
}

export function $isImageNode(
  node: LexicalNode | null | undefined,
): node is ImageNode {
  return node instanceof ImageNode;
}
