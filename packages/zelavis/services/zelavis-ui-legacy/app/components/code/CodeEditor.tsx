import type { Compartment, Extension } from "@codemirror/state";
import type { EditorView as CodeMirrorEditorView } from "@codemirror/view";
import { useEffect, useRef, useState } from "react";

import { cn } from "#/lib/utils";

type CodeEditorLanguage = "json" | "text";

type CodeEditorProps = {
  value: string;
  onChange?: (value: string) => void;
  language?: CodeEditorLanguage;
  readOnly?: boolean;
  className?: string;
  minHeight?: number;
  ariaLabel?: string;
};

function readOnlyExtensions(
  EditorState: typeof import("@codemirror/state").EditorState,
  EditorView: typeof import("@codemirror/view").EditorView,
  readOnly: boolean,
) {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

function getLanguageExtensions(
  language: CodeEditorLanguage,
  modules: {
    json: typeof import("@codemirror/lang-json").json;
    jsonParseLinter: typeof import("@codemirror/lang-json").jsonParseLinter;
    linter: typeof import("@codemirror/lint").linter;
    lintGutter: typeof import("@codemirror/lint").lintGutter;
  },
): Extension[] {
  if (language === "json") {
    return [modules.json(), modules.lintGutter(), modules.linter(modules.jsonParseLinter())];
  }

  return [];
}

export function CodeEditor({
  value,
  onChange,
  language = "text",
  readOnly = false,
  className,
  minHeight = 288,
  ariaLabel = "Code editor",
}: CodeEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CodeMirrorEditorView | null>(null);
  const readOnlyCompartmentRef = useRef<Compartment | null>(null);
  const languageCompartmentRef = useRef<Compartment | null>(null);
  const onChangeRef = useRef(onChange);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const currentValue = editor.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    editor.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }, [value]);

  useEffect(() => {
    let cancelled = false;

    async function mountEditor() {
      const [
        { basicSetup, EditorView },
        { Compartment, EditorState },
        { json, jsonParseLinter },
        { linter, lintGutter },
      ] = await Promise.all([
        import("codemirror"),
        import("@codemirror/state"),
        import("@codemirror/lang-json"),
        import("@codemirror/lint"),
      ]);

      if (cancelled || !containerRef.current) {
        return;
      }

      const readOnlyCompartment = new Compartment();
      const languageCompartment = new Compartment();
      readOnlyCompartmentRef.current = readOnlyCompartment;
      languageCompartmentRef.current = languageCompartment;

      const theme = EditorView.theme({
        "&": {
          backgroundColor: "color-mix(in oklab, var(--muted) 18%, transparent)",
          color: "var(--foreground)",
          fontSize: "12px",
          minHeight: `${minHeight}px`,
        },
        "&.cm-focused": {
          outline: "none",
        },
        ".cm-content": {
          caretColor: "var(--foreground)",
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
          lineHeight: "1.6",
          minHeight: `${minHeight}px`,
          padding: "16px 0",
        },
        ".cm-gutters": {
          backgroundColor: "transparent",
          borderRightColor: "var(--border)",
          color: "var(--muted-foreground)",
        },
        ".cm-line": {
          padding: "0 16px",
        },
        ".cm-activeLine": {
          backgroundColor: "color-mix(in oklab, var(--muted) 35%, transparent)",
        },
        ".cm-activeLineGutter": {
          backgroundColor: "color-mix(in oklab, var(--muted) 35%, transparent)",
        },
        ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
          backgroundColor: "color-mix(in oklab, var(--primary) 18%, transparent)",
        },
        ".cm-tooltip": {
          backgroundColor: "var(--popover)",
          borderColor: "var(--border)",
          color: "var(--popover-foreground)",
        },
        ".cm-diagnostic": {
          fontFamily: "inherit",
        },
      });

      const view = new EditorView({
        parent: containerRef.current,
        state: EditorState.create({
          doc: value,
          extensions: [
            basicSetup,
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({ "aria-label": ariaLabel }),
            theme,
            languageCompartment.of(
              getLanguageExtensions(language, { json, jsonParseLinter, linter, lintGutter }),
            ),
            readOnlyCompartment.of(readOnlyExtensions(EditorState, EditorView, readOnly)),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) {
                onChangeRef.current?.(update.state.doc.toString());
              }
            }),
          ],
        }),
      });

      editorRef.current = view;
      setReady(true);
    }

    void mountEditor();

    return () => {
      cancelled = true;
      editorRef.current?.destroy();
      editorRef.current = null;
      readOnlyCompartmentRef.current = null;
      languageCompartmentRef.current = null;
      setReady(false);
    };
  }, [ariaLabel, language, minHeight, readOnly]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border bg-muted/20 text-xs shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        className,
      )}
      style={{ minHeight }}
    >
      <div ref={containerRef} />
      {ready ? null : (
        <div
          className="grid place-items-center px-4 text-sm text-muted-foreground"
          style={{ minHeight }}
        >
          Loading editor...
        </div>
      )}
    </div>
  );
}
