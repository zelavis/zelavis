import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import { createEmptyHistoryState, registerHistory } from "@lexical/history";
import { $toggleLink, LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode, registerList } from "@lexical/list";
import { $createHeadingNode, $createQuoteNode, HeadingNode, QuoteNode, registerRichText } from "@lexical/rich-text";
import { $setBlocksType } from "@lexical/selection";
import { $createParagraphNode, $getRoot, $getSelection, $insertNodes, $isRangeSelection, COMMAND_PRIORITY_LOW, FORMAT_TEXT_COMMAND, createEditor, type LexicalEditor } from "lexical";
import { button, node } from "./dom.ts";
import { $createCalloutNode, $createFileCardNode, $createImageNode, CalloutNode, FileCardNode, ImageNode } from "./rich-text-nodes.ts";

/**
 * The rich text editor island: Lexical without its React bindings. The toolbar, the link and image inputs and the
 * media and file pickers are plain DOM; every change is announced as a bubbling `rich-change` event carrying the HTML.
 */

interface Media { src: string; altText: string; label: string }
interface FileItem { href: string; label: string; meta: string }

const normalize = (html: string) => { const trimmed = html.trim(); return trimmed === "<p><br></p>" ? "" : trimmed; };

function load(editor: LexicalEditor, html: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    if (!html.trim()) { root.append($createParagraphNode()); return; }
    const dom = new DOMParser().parseFromString(html, "text/html");
    root.select();
    $insertNodes($generateNodesFromDOM(editor, dom));
  }, { discrete: true });
}

export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const media = (Array.isArray(props.mediaItems) ? props.mediaItems : []) as Media[];
  const files = (Array.isArray(props.fileItems) ? props.fileItems : []) as FileItem[];
  host.classList.add("rte");
  const surface = node("div", { class: "rte-surface", contenteditable: "true", role: "textbox", "aria-multiline": "true", "aria-label": "Rich text" });
  const placeholder = node("div", { class: "rte-placeholder" }, String(props.placeholder ?? "Start writing..."));
  const editor = createEditor({
    namespace: "zelavis-content-editor",
    nodes: [HeadingNode, QuoteNode, ListNode, ListItemNode, LinkNode, ImageNode, CalloutNode, FileCardNode],
    theme: { text: { bold: "rte-bold", italic: "rte-italic", underline: "rte-underline" }, heading: { h2: "rte-h2", h3: "rte-h3" }, quote: "rte-quote", link: "rte-link", list: { ul: "rte-ul", ol: "rte-ol", listitem: "rte-li" } },
    onError(error) { throw error; }
  });
  editor.setRootElement(surface);
  const cleanups = [
    registerRichText(editor), registerHistory(editor, createEmptyHistoryState(), 300), registerList(editor),
    editor.registerCommand(TOGGLE_LINK_COMMAND, payload => { $toggleLink(payload); return true; }, COMMAND_PRIORITY_LOW)
  ];
  load(editor, String(props.value ?? ""));
  let last = normalize(String(props.value ?? ""));
  cleanups.push(editor.registerUpdateListener(({ editorState }) => {
    editorState.read(() => {
      const html = normalize($generateHtmlFromNodes(editor, null));
      placeholder.hidden = $getRoot().getTextContent().length > 0 || $getRoot().getChildrenSize() > 1;
      if (html === last) return;
      last = html;
      host.dispatchEvent(new CustomEvent("rich-change", { bubbles: true, detail: html }));
    });
  }));

  const act = (label: string, run: () => void) => button(label, run, { "aria-label": label });
  const blocks = (create: () => ReturnType<typeof $createParagraphNode> | ReturnType<typeof $createHeadingNode> | ReturnType<typeof $createQuoteNode>) => editor.update(() => { const selection = $getSelection(); if ($isRangeSelection(selection)) $setBlocksType(selection, create); });
  const linkInput = node("input", { placeholder: "https://…", "aria-label": "Link URL" });
  const applyLink = () => { editor.dispatchCommand(TOGGLE_LINK_COMMAND, linkInput.value.trim() ? linkInput.value.trim() : null); linkInput.value = ""; };
  const insertImage = (src: string, altText: string) => { if (!src.trim()) return; editor.update(() => { const paragraph = $createParagraphNode(); paragraph.append($createImageNode({ src: src.trim(), altText: altText.trim() })); $insertNodes([paragraph, $createParagraphNode()]); }); };
  const imageUrl = node("input", { placeholder: "https://…", "aria-label": "Image URL" });
  const imageAlt = node("input", { placeholder: "Alt text", "aria-label": "Image alt text" });
  const panel = node("div", { class: "rte-panel", hidden: "" });
  const showPanel = (kind: "media" | "files") => {
    if (!panel.hidden && panel.dataset.kind === kind) { panel.hidden = true; return; }
    panel.dataset.kind = kind; panel.hidden = false;
    panel.replaceChildren(
      node("strong", {}, kind === "media" ? "Embed from Media" : "Insert file card"),
      node("p", { class: "muted" }, kind === "media" ? "Pick an uploaded image and drop it into the current rich-text field." : "Insert a linked card for an uploaded file without leaving the editor."),
      ...(kind === "media"
        ? media.length ? [node("div", { class: "rte-picker" }, ...media.map(item => { const choice = button("", () => { insertImage(item.src, item.altText); panel.hidden = true; }, { class: "rte-choice" }); choice.append(node("img", { src: item.src, alt: item.altText }), node("strong", {}, item.label), node("small", { class: "muted" }, item.altText || item.src)); return choice; }))] : [node("p", { class: "muted" }, "No image files available yet. Upload one in Media first or paste a direct URL above.")]
        : files.length ? [node("div", { class: "rte-picker" }, ...files.map(item => { const choice = button("", () => { editor.update(() => { $insertNodes([$createFileCardNode(item), $createParagraphNode()]); }); panel.hidden = true; }, { class: "rte-choice" }); choice.append(node("strong", {}, item.label), node("small", { class: "muted" }, item.meta)); return choice; }))] : [node("p", { class: "muted" }, "No stored files available yet. Upload one in Media or Backend > Storage first.")]));
  };
  const toolbar = node("div", { class: "rte-toolbar" },
    node("div", { class: "actions" },
      act("Bold", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")), act("Italic", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")), act("Underline", () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")),
      act("Bullet list", () => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)), act("Numbered list", () => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)),
      act("H2", () => blocks(() => $createHeadingNode("h2"))), act("H3", () => blocks(() => $createHeadingNode("h3"))), act("Quote", () => blocks(() => $createQuoteNode())),
      act("Link", applyLink), act("Callout", () => editor.update(() => { $insertNodes([$createCalloutNode({ title: "Editor note", body: "Use this block for standout context, summaries, or handoff notes." }), $createParagraphNode()]); })),
      act("Paragraph", () => blocks(() => $createParagraphNode())), act("Media", () => showPanel("media")), act("File Card", () => showPanel("files"))),
    node("div", { class: "filters" }, node("label", {}, linkInput), button("Apply link", applyLink)),
    node("div", { class: "filters" }, node("label", {}, imageUrl), node("label", {}, imageAlt), button("Insert image", () => { insertImage(imageUrl.value, imageAlt.value); imageUrl.value = ""; imageAlt.value = ""; })),
    panel);
  host.replaceChildren(toolbar, node("div", { class: "rte-editor" }, surface, placeholder));
  editor.getEditorState().read(() => { placeholder.hidden = $getRoot().getTextContent().length > 0 || $getRoot().getChildrenSize() > 1; });
  return () => { for (const clean of cleanups) clean(); editor.setRootElement(null); host.replaceChildren(); };
}

