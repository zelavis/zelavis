import { $generateHtmlFromNodes, $generateNodesFromDOM } from "@lexical/html";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { $createParagraphNode, $getRoot, $insertNodes } from "lexical";
import { useEffect, useMemo, useRef } from "react";

function normalizeHtml(value: string): string {
  const trimmed = value.trim();
  return trimmed === "<p><br></p>" ? "" : trimmed;
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

    editor.update(() => {
      const root = $getRoot();
      root.clear();

      if (!nextValue.trim()) {
        root.append($createParagraphNode());
      } else {
        const parser = new DOMParser();
        const dom = parser.parseFromString(nextValue, "text/html");
        const nodes = $generateNodesFromDOM(editor, dom);
        root.select();
        $insertNodes(nodes);
      }
    });
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

export function RichTextEditor(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const initialConfig = useMemo(
    () => ({
      namespace: "zelavis-content-editor",
      onError(error: Error) {
        throw error;
      },
      editorState(editor: { update: (callback: () => void) => void }) {
        editor.update(() => {
          const root = $getRoot();
          root.clear();

          if (!props.value.trim()) {
            root.append($createParagraphNode());
            return;
          }

          const parser = new DOMParser();
          const dom = parser.parseFromString(props.value, "text/html");
          const nodes = $generateNodesFromDOM(editor as never, dom);
          root.select();
          $insertNodes(nodes);
        });
      },
    }),
    [props.value],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="grid gap-2">
        <RichTextPlugin
          contentEditable={
            <div className="relative">
              <ContentEditable className="min-h-56 rounded-md border bg-background px-4 py-3 text-sm leading-7 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2" />
            </div>
          }
          placeholder={
            <div className="pointer-events-none absolute left-4 top-3 text-sm text-muted-foreground">
              {props.placeholder ?? "Start writing..."}
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <HistoryPlugin />
        <HtmlSyncPlugin value={props.value} onChange={props.onChange} />
      </div>
    </LexicalComposer>
  );
}
