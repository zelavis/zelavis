import { Effect } from "effect";
import { ApiError } from "./api.ts";

/**
 * A code editor island (CodeMirror). Every change is announced as a bubbling `code-change` event on the host, so the
 * form around it can keep the value without the editor knowing the form. The editor lives as long as the page does.
 */
export function mount(host: HTMLElement, props: Record<string, unknown>) {
  const value = String(props.value ?? "");
  const language = props.language === "json" ? "json" : "text";
  const readOnly = props.readOnly === true;
  const minHeight = Number(props.minHeight) > 0 ? Number(props.minHeight) : 288;
  const ariaLabel = String(props.ariaLabel ?? "Code editor");
  host.classList.add("code-editor");
  host.style.minHeight = `${minHeight}px`;
  host.textContent = "Loading editor...";

  let destroy = () => {};
  let closed = false;
  const fiber = Effect.runFork(Effect.tryPromise({
    try: async () => {
      const [{ basicSetup, EditorView }, { EditorState }, { json, jsonParseLinter }, { linter, lintGutter }] = await Promise.all([import("codemirror"), import("@codemirror/state"), import("@codemirror/lang-json"), import("@codemirror/lint")]);
      if (closed) return;
      const theme = EditorView.theme({
        "&": { backgroundColor: "var(--hover)", color: "inherit", fontSize: "12px", minHeight: `${minHeight}px` },
        "&.cm-focused": { outline: "none" },
        ".cm-content": { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: "1.6", minHeight: `${minHeight}px`, padding: "16px 0" },
        ".cm-gutters": { backgroundColor: "transparent", borderRightColor: "var(--border)", color: "var(--muted)" },
        ".cm-line": { padding: "0 16px" }
      });
      host.textContent = "";
      const view = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: value,
          extensions: [basicSetup, EditorView.lineWrapping, EditorView.contentAttributes.of({ "aria-label": ariaLabel }), theme,
            ...(language === "json" ? [json(), lintGutter(), linter(jsonParseLinter())] : []),
            EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly),
            EditorView.updateListener.of(update => { if (update.docChanged) host.dispatchEvent(new CustomEvent("code-change", { bubbles: true, detail: update.state.doc.toString() })); })]
        })
      });
      destroy = () => view.destroy();
    },
    catch: cause => new ApiError({ message: String(cause) })
  }).pipe(Effect.catch(error => Effect.sync(() => { host.textContent = error.message; }))));
  return () => { closed = true; Effect.runFork(Effect.sync(() => { destroy(); host.replaceChildren(); })); void fiber; };
}
