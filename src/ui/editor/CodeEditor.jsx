// CodeMirror 6 editor bound to the active workspace file and connected to the
// AADL language server. Each file keeps its own EditorState, so switching tabs
// preserves undo history and selection.

import { useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { EditorState } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentUnit, indentOnInput } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { lintGutter } from "@codemirror/lint";
import { aadlLanguage, aadlHighlighting, aadlIndentation } from "./aadlLanguage.js";
import { lspExtensions, toOffset } from "./lspExtensions.js";
import { uriOf } from "./lspClient.js";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--editor-bg)", color: "var(--editor-fg)", fontSize: "14px" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "19px" },
  ".cm-content": { caretColor: "var(--editor-fg)" },
  ".cm-gutters": { backgroundColor: "var(--editor-bg)", color: "var(--gutter-fg)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 20px" },
  ".cm-foldGutter .cm-gutterElement": { padding: "0 4px", cursor: "pointer", color: "var(--gutter-fg)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--gutter-active-fg)" },
  ".cm-activeLine": { backgroundColor: "var(--line-hl)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--editor-fg)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--selection) 55%, transparent)" },
  ".cm-matchingBracket": { backgroundColor: "transparent", outline: "1px solid var(--muted)" },
  ".cm-foldPlaceholder": { backgroundColor: "#80808033", border: "none", color: "var(--muted)", padding: "0 4px" },
  ".cm-panels": { backgroundColor: "var(--sidebar-bg)", color: "var(--fg)" },
  ".cm-tooltip": { backgroundColor: "var(--menu-bg)", color: "var(--menu-fg)", border: "1px solid var(--border)", borderRadius: "3px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--menu-sel)", color: "#ffffff" },
  ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--mono)", maxHeight: "16em" },
  ".cm-completionDetail": { opacity: 0.7, fontStyle: "normal", marginLeft: "1em" },
  ".cm-lsp-hover": { maxWidth: "560px", padding: "4px 8px", fontSize: "13px" },
  ".cm-lsp-hover pre": { margin: "2px 0 4px", fontFamily: "var(--mono)", whiteSpace: "pre-wrap", color: "var(--tok-type)" },
  ".cm-lsp-hover .muted": { color: "var(--muted)", fontSize: "12px", marginTop: "2px" },
  ".cm-diagnostic-error": { borderLeftColor: "var(--err)" },
  ".cm-diagnostic-warning": { borderLeftColor: "var(--warn)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--info)" },
});

/**
 * @param {{ file: {name:string,text:string,readOnly?:boolean}|null, client: import('./lspClient.js').LspClient,
 *   onChange: (name:string, text:string) => void, annexKeywords: string[],
 *   onNavigate: (loc) => void, onReferences: (locs, word:string) => void,
 *   onWorkspaceEdit: (changes: Record<string, object[]>) => void, ref?: any }} props
 */
export default function CodeEditor({ file, client, collab, onChange, annexKeywords, onNavigate, onReferences, onWorkspaceEdit, ref }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const states = useRef(new Map());
  const current = useRef(null);
  // Extensions are built once per file; route callbacks through a ref so they stay current.
  const cb = useRef({});
  cb.current = { onChange, onNavigate, onReferences, onWorkspaceEdit };

  const keywordsKey = annexKeywords.join(" ");
  const language = useMemo(() => aadlLanguage(annexKeywords), [keywordsKey]);

  const makeState = (name, text, readOnly) => {
    // In a live session the document is bound to the shared Y.Text (remote edits and cursors).
    const ytext = name && !readOnly ? collab?.ytext(name) : null;
    return EditorState.create({
    doc: ytext ? ytext.toString() : text,
    extensions: [
      lineNumbers(), highlightActiveLineGutter(), ytext ? yCollab(ytext, collab.awareness, { undoManager: new Y.UndoManager(ytext) }) : history(), drawSelection(), highlightActiveLine(),
      bracketMatching(), closeBrackets(), highlightSelectionMatches(), lintGutter(), indentOnInput(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      indentUnit.of("  "), EditorState.tabSize.of(2),
      language, aadlHighlighting, aadlIndentation, theme,
      // Read-only files stay focusable (EditorState.readOnly blocks edits) so keyboard and
      // screen-reader users can still move through and scroll them.
      EditorState.readOnly.of(readOnly),
      EditorView.contentAttributes.of({ tabindex: "0", "aria-label": name ? `${name}${readOnly ? " (read-only)" : ""}, AADL source` : "No file open" }),
      name ? lspExtensions({
        client,
        name,
        readOnly,
        onNavigate: (loc) => cb.current.onNavigate(loc),
        onReferences: (locs, word) => cb.current.onReferences(locs, word),
        onRename: (edit, view) => {
          const own = edit.changes?.[uriOf(name)] || [];
          if (own.length) {
            const doc = view.state.doc;
            view.dispatch({ changes: own.map((e) => ({ from: toOffset(doc, e.range.start), to: toOffset(doc, e.range.end), insert: e.newText })), userEvent: "rename" });
          }
          const others = Object.fromEntries(Object.entries(edit.changes || {}).filter(([u]) => u !== uriOf(name)));
          if (Object.keys(others).length) cb.current.onWorkspaceEdit(others);
        },
      }) : [],
      EditorView.updateListener.of((u) => {
        if (u.docChanged && name) cb.current.onChange?.(name, u.state.doc.toString());
      }),
    ],
    });
  };

  useEffect(() => {
    const view = new EditorView({ parent: hostRef.current, state: makeState(null, "", true) });
    viewRef.current = view;
    // Development aid for driving the editor from the console / browser tests.
    if (import.meta.env.DEV) window.__wosateEditor = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Changing the annex keyword set (plug-ins toggled) or joining / leaving a live session invalidates cached states.
  useEffect(() => {
    states.current.clear();
    current.current = null;
  }, [language, collab]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const name = file?.name ?? null;
    if (name && current.current === name && view.state.doc.toString() === file.text) return;
    if (current.current) states.current.set(current.current, view.state);
    if (!name) {
      view.setState(makeState(null, "", true));
      current.current = null;
      return;
    }
    let st = states.current.get(name);
    if (st && st.doc.toString() !== file.text) {
      // Text replaced from outside this editor (rename in another file, example reload, co-editing):
      // apply it as a change so undo history and cursor survive.
      const old = st.doc.toString();
      let from = 0;
      while (from < old.length && from < file.text.length && old[from] === file.text[from]) from++;
      let endOld = old.length, endNew = file.text.length;
      while (endOld > from && endNew > from && old[endOld - 1] === file.text[endNew - 1]) {
        endOld--;
        endNew--;
      }
      st = st.update({ changes: { from, to: endOld, insert: file.text.slice(from, endNew) }, userEvent: "external" }).state;
    }
    if (!st) st = makeState(name, file.text, !!file.readOnly);
    view.setState(st);
    current.current = name;
  }, [file?.name, file?.text, file?.readOnly, language, collab]);

  useImperativeHandle(ref, () => ({
    goto(lineNo, col = 1) {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
      const line = doc.line(Math.min(Math.max(1, lineNo), doc.lines));
      const pos = Math.min(line.from + Math.max(0, col - 1), line.to);
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    },
    get view() {
      return viewRef.current;
    },
  }), []);

  return <div className="editor-host" ref={hostRef} />;
}
