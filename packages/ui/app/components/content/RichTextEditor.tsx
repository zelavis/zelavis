import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import { LinkNode, TOGGLE_LINK_COMMAND } from "@lexical/link";
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND, ListItemNode, ListNode } from "@lexical/list";
import { $setBlocksType } from "@lexical/selection";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createHeadingNode, HeadingNode, QuoteNode } from "@lexical/rich-text";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  FORMAT_TEXT_COMMAND,
  type LexicalEditor,
} from "lexical";
import {
  Bold,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Paperclip,
  Pilcrow,
  Quote,
  Underline,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet";
import { $createCalloutNode, CalloutNode } from "./CalloutNode";
import { $createFileCardNode, FileCardNode } from "./FileCardNode";
import { $createImageNode, ImageNode } from "./ImageNode";

function normalizeHtml(value: string): string {
  const trimmed = value.trim();
  return trimmed === "<p><br></p>" ? "" : trimmed;
}

function syncHtmlIntoEditor(editor: LexicalEditor, html: string) {
  editor.update(() => {
    const root = $getRoot();
    root.clear();

    if (!html.trim()) {
      root.append($createParagraphNode());
      return;
    }

    if (typeof DOMParser === "undefined" || typeof document === "undefined") {
      root.append($createParagraphNode().append($createTextNode(html)));
      return;
    }

    const parser = new DOMParser();
    const dom = parser.parseFromString(html, "text/html");
    const nodes = $generateNodesFromDOM(editor, dom);
    root.select();
    $insertNodes(nodes);
  });
}

function HtmlSyncPlugin(props: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const lastValueRef = useRef<string>(props.value);

  useEffect(() => {
    const nextValue = props.value ?? "";
    if (nextValue === lastValueRef.current) {
      return;
    }

    syncHtmlIntoEditor(editor, nextValue);
    lastValueRef.current = nextValue;
  }, [editor, props.value]);

  return (
    <OnChangePlugin
      onChange={(editorState, currentEditor) => {
        editorState.read(() => {
          const nextValue = normalizeHtml($generateHtmlFromNodes(currentEditor, null));
          lastValueRef.current = nextValue;
          props.onChange(nextValue);
        });
      }}
    />
  );
}

function ToolbarPlugin(props: {
  mediaItems: Array<{ src: string; altText: string; label: string }>;
  fileItems: Array<{ href: string; label: string; meta: string }>;
}) {
  const [editor] = useLexicalComposerContext();
  const [showMediaPanel, setShowMediaPanel] = useState(false);
  const [showFilePanel, setShowFilePanel] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageAlt, setImageAlt] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  function insertParagraphBreak() {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createParagraphNode());
      }
    });
  }

  function insertHeading(tag: "h2" | "h3") {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createHeadingNode(tag));
      }
    });
  }

  function applyLink() {
    editor.dispatchCommand(
      TOGGLE_LINK_COMMAND,
      linkUrl.trim().length > 0 ? linkUrl.trim() : null,
    );
    setLinkUrl("");
  }

  function insertCallout() {
    editor.update(() => {
      $insertNodes([
        $createCalloutNode({
          title: "Editor note",
          body: "Use this block for standout context, summaries, or handoff notes.",
        }),
        $createParagraphNode(),
      ]);
    });
  }

  function insertImage(src: string, altText: string) {
    if (!src.trim()) {
      return;
    }

    editor.update(() => {
      const imageNode = $createImageNode({
        src: src.trim(),
        altText: altText.trim(),
      });
      const paragraph = $createParagraphNode();
      paragraph.append(imageNode);
      $insertNodes([paragraph, $createParagraphNode()]);
    });
  }

  function insertFileCard(item: { href: string; label: string; meta: string }) {
    editor.update(() => {
      $insertNodes([
        $createFileCardNode(item),
        $createParagraphNode(),
      ]);
    });
  }

  return (
    <div className="grid gap-3 rounded-md border bg-muted/15 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToolbarIconButton
          label="Bold"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "bold")}
          icon={<Bold className="size-4" />}
        />
        <ToolbarIconButton
          label="Italic"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "italic")}
          icon={<Italic className="size-4" />}
        />
        <ToolbarIconButton
          label="Underline"
          onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, "underline")}
          icon={<Underline className="size-4" />}
        />
        <ToolbarIconButton
          label="Bullet list"
          onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
          icon={<List className="size-4" />}
        />
        <ToolbarIconButton
          label="Numbered list"
          onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
          icon={<ListOrdered className="size-4" />}
        />
        <ToolbarIconButton
          label="H2"
          onClick={() => insertHeading("h2")}
          icon={<Heading2 className="size-4" />}
        />
        <ToolbarIconButton
          label="H3"
          onClick={() => insertHeading("h3")}
          icon={<Heading3 className="size-4" />}
        />
        <ToolbarIconButton
          label="Quote"
          onClick={() =>
            editor.update(() => {
              const selection = $getSelection();
              if ($isRangeSelection(selection)) {
                $setBlocksType(selection, () => new QuoteNode());
              }
            })
          }
          icon={<Quote className="size-4" />}
        />
        <ToolbarIconButton
          label="Link"
          onClick={applyLink}
          icon={<Link2 className="size-4" />}
        />
        <ToolbarIconButton
          label="Callout"
          onClick={insertCallout}
          icon={<MessageSquareQuote className="size-4" />}
        />
        <ToolbarIconButton
          label="Paragraph"
          onClick={insertParagraphBreak}
          icon={<Pilcrow className="size-4" />}
        />
        <ToolbarIconButton
          label="Media"
          onClick={() => setShowMediaPanel((current) => !current)}
          icon={<ImagePlus className="size-4" />}
        />
        <ToolbarIconButton
          label="File Card"
          onClick={() => setShowFilePanel((current) => !current)}
          icon={<Paperclip className="size-4" />}
        />
      </div>

      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
        <Input
          value={linkUrl}
          onChange={(event) => setLinkUrl(event.target.value)}
          placeholder="https://…"
          aria-label="Link URL"
        />
        <Button type="button" size="sm" variant="outline" onClick={applyLink}>
          Apply link
        </Button>
      </div>

      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Input
          value={imageUrl}
          onChange={(event) => setImageUrl(event.target.value)}
          placeholder="https://…"
          aria-label="Image URL"
        />
        <Input
          value={imageAlt}
          onChange={(event) => setImageAlt(event.target.value)}
          placeholder="Alt text"
          aria-label="Image alt text"
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            insertImage(imageUrl, imageAlt);
            setImageUrl("");
            setImageAlt("");
          }}
          disabled={!imageUrl.trim()}
        >
          Insert image
        </Button>
      </div>

      <Sheet open={showMediaPanel} onOpenChange={setShowMediaPanel}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Embed from Media</SheetTitle>
            <SheetDescription>
              Pick an uploaded image and drop it into the current rich-text field.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 overflow-auto px-4 pb-4">
            {props.mediaItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No image files available yet. Upload one in Media first or paste a direct URL above.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {props.mediaItems.map((item) => (
                  <button
                    key={item.src}
                    type="button"
                    onClick={() => {
                      insertImage(item.src, item.altText);
                      setShowMediaPanel(false);
                    }}
                    className="grid gap-2 rounded-md border p-2 text-left transition-colors hover:bg-accent"
                  >
                    <img
                      src={item.src}
                      alt={item.altText}
                      className="h-24 w-full rounded-md object-cover"
                    />
                    <div className="grid gap-0.5">
                      <span className="text-sm font-medium text-foreground">{item.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{item.altText || item.src}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={showFilePanel} onOpenChange={setShowFilePanel}>
        <SheetContent side="right" className="w-full sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Insert file card</SheetTitle>
            <SheetDescription>
              Insert a linked card for an uploaded file without leaving the editor.
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-3 overflow-auto px-4 pb-4">
            {props.fileItems.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No stored files available yet. Upload one in Media or Core &gt; Storage first.
              </p>
            ) : (
              <div className="grid gap-2">
                {props.fileItems.map((item) => (
                  <button
                    key={item.href}
                    type="button"
                    onClick={() => {
                      insertFileCard(item);
                      setShowFilePanel(false);
                    }}
                    className="grid gap-1 rounded-md border p-3 text-left transition-colors hover:bg-accent"
                  >
                    <span className="text-sm font-medium text-foreground">{item.label}</span>
                    <span className="text-xs text-muted-foreground">{item.meta}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ToolbarIconButton(props: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button type="button" size="sm" variant="outline" onClick={props.onClick}>
      {props.icon}
      {props.label}
    </Button>
  );
}

export function RichTextEditor(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mediaItems?: Array<{ src: string; altText: string; label: string }>;
  fileItems?: Array<{ href: string; label: string; meta: string }>;
}) {
  const initialConfig = useMemo(
    () => ({
      namespace: "zelavis-content-editor",
      nodes: [
        HeadingNode,
        QuoteNode,
        ListNode,
        ListItemNode,
        LinkNode,
        ImageNode,
        CalloutNode,
        FileCardNode,
      ],
      onError(error: Error) {
        throw error;
      },
      editorState(editor: LexicalEditor) {
        syncHtmlIntoEditor(editor, props.value);
      },
    }),
    [props.value],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="grid gap-3">
        <ToolbarPlugin
          mediaItems={props.mediaItems ?? []}
          fileItems={props.fileItems ?? []}
        />
        <div className="relative">
          <RichTextPlugin
            contentEditable={
              <ContentEditable className="min-h-72 rounded-md border bg-background px-4 py-3 text-sm leading-7 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
            }
            placeholder={
              <div className="pointer-events-none absolute left-4 top-3 text-sm text-muted-foreground">
                {props.placeholder ?? "Start writing..."}
              </div>
            }
            ErrorBoundary={LexicalErrorBoundary}
          />
        </div>
        <HistoryPlugin />
        <LinkPlugin />
        <HtmlSyncPlugin value={props.value} onChange={props.onChange} />
      </div>
    </LexicalComposer>
  );
}
