import {
  $applyNodeReplacement,
  DecoratorNode,
  type DOMConversionMap,
  type DOMConversionOutput,
  type DOMExportOutput,
  type LexicalNode,
  type NodeKey,
  type SerializedLexicalNode,
} from "lexical";
import * as React from "react";

export interface SerializedCalloutNode {
  type: "zelavis-callout";
  version: 1;
  title: string;
  body: string;
}

function convertCalloutElement(domNode: Node): DOMConversionOutput | null {
  if (!(domNode instanceof HTMLElement)) {
    return null;
  }

  if (domNode.dataset.zelavisCallout !== "true") {
    return null;
  }

  return {
    node: $createCalloutNode({
      title: domNode.dataset.title ?? "Callout",
      body: domNode.dataset.body ?? domNode.textContent ?? "",
    }),
  };
}

export class CalloutNode extends DecoratorNode<React.JSX.Element> {
  __title: string;
  __body: string;

  static getType(): string {
    return "zelavis-callout";
  }

  static clone(node: CalloutNode): CalloutNode {
    return new CalloutNode(node.__title, node.__body, node.__key);
  }

  static importJSON(
    serializedNode: SerializedLexicalNode & Record<string, unknown>,
  ): CalloutNode {
    return $createCalloutNode({
      title:
        typeof serializedNode.title === "string"
          ? serializedNode.title
          : "Callout",
      body: typeof serializedNode.body === "string" ? serializedNode.body : "",
    });
  }

  static importDOM(): DOMConversionMap | null {
    return {
      div: () => ({
        conversion: convertCalloutElement,
        priority: 2,
      }),
    };
  }

  constructor(title: string, body: string, key?: NodeKey) {
    super(key);
    this.__title = title;
    this.__body = body;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement("div");
    element.dataset.zelavisCallout = "true";
    element.dataset.title = this.__title;
    element.dataset.body = this.__body;
    element.className =
      "my-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3";

    const title = document.createElement("p");
    title.textContent = this.__title;
    title.className = "font-medium";
    element.appendChild(title);

    const body = document.createElement("p");
    body.textContent = this.__body;
    body.className = "mt-1";
    element.appendChild(body);

    return { element };
  }

  exportJSON(): SerializedCalloutNode {
    return {
      type: "zelavis-callout",
      version: 1,
      title: this.__title,
      body: this.__body,
    };
  }

  createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "block";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  decorate(): React.JSX.Element {
    return (
      <div className="my-4 rounded-md border border-primary/30 bg-primary/5 px-4 py-3">
        <p className="font-medium text-foreground">{this.__title}</p>
        <p className="mt-1 text-sm text-muted-foreground">{this.__body}</p>
      </div>
    );
  }
}

export function $createCalloutNode(input: {
  title: string;
  body: string;
}): CalloutNode {
  return $applyNodeReplacement(new CalloutNode(input.title, input.body));
}

export function $isCalloutNode(
  node: LexicalNode | null | undefined,
): node is CalloutNode {
  return node instanceof CalloutNode;
}
