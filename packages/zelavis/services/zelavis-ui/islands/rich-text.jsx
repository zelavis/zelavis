/** @jsxRuntime classic */
import React from "react";
import { createRoot } from "react-dom/client";
import { RichTextEditor } from "../../zelavis-ui-legacy/app/components/content/RichTextEditor.tsx";

/**
 * The Lexical rich text editor, as an island: Lexical's editor is a React component, so React stays here and nowhere
 * else on the entry page. Every change is announced as a bubbling `rich-change` event carrying the HTML.
 */
export function mount(host, props) {
  const root = createRoot(host);
  root.render(<RichTextEditor value={String(props.value ?? "")} placeholder={props.placeholder} mediaItems={props.mediaItems ?? []} fileItems={props.fileItems ?? []}
    onChange={value => host.dispatchEvent(new CustomEvent("rich-change", { bubbles: true, detail: value }))} />);
  return () => root.unmount();
}
