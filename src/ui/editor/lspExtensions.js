// CodeMirror 6 extensions that connect one editor document to the AADL
// language server: completion, hover, go to definition (F12 / Ctrl+click),
// find references (Shift+F12), rename (F2), folding and diagnostics.

import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, hoverTooltip, keymap, ViewPlugin } from "@codemirror/view";
import { foldService, foldGutter, foldKeymap } from "@codemirror/language";
import { autocompletion, snippet, completionKeymap } from "@codemirror/autocomplete";
import { setDiagnostics } from "@codemirror/lint";
import { uriOf } from "./lspClient.js";

const KIND_TYPE = {
  2: "method", 3: "function", 5: "property", 6: "variable", 7: "class", 8: "interface", 9: "namespace", 10: "property",
  11: "constant", 12: "constant", 13: "enum", 14: "keyword", 15: "text", 18: "variable", 19: "namespace", 20: "enum",
  21: "constant", 22: "type", 23: "function", 25: "type",
};

export const toPosition = (doc, offset) => {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
};

export const toOffset = (doc, pos) => {
  const line = doc.line(Math.min(doc.lines, pos.line + 1));
  return Math.min(line.to, line.from + pos.character);
};

/** LSP snippet syntax (${1:name}, $0) to CodeMirror snippet syntax (${name}, ${}). */
const cmSnippet = (text) => text.replace(/\$\{\d+:([^}]*)\}/g, "${$1}").replace(/\$\d+/g, "${}");

const setFolds = StateEffect.define();
const foldField = StateField.define({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFolds)) return e.value;
    return value;
  },
});

function renderHover(markdown) {
  const dom = document.createElement("div");
  dom.className = "cm-lsp-hover";
  const parts = markdown.split(/```(?:aadl)?\n?/);
  parts.forEach((part, i) => {
    const text = part.trim();
    if (!text) return;
    const el = document.createElement(i % 2 ? "pre" : "div");
    if (i % 2) el.textContent = text;
    else {
      for (const line of text.split("\n")) {
        const p = document.createElement("div");
        const italic = /^\*(.*)\*$/.exec(line);
        p.textContent = italic ? italic[1] : line;
        if (italic) p.className = "muted";
        el.append(p);
      }
    }
    dom.append(el);
  });
  return dom;
}

/**
 * @param {{ client: import('./lspClient.js').LspClient, name: string,
 *   onNavigate: (loc) => void, onReferences: (locs, word) => void, onRename: (edit, view) => void,
 *   readOnly: boolean }} opts
 */
export function lspExtensions({ client, name, onNavigate, onReferences, onRename, readOnly }) {
  const uri = uriOf(name);
  const sync = (state) => {
    if (!readOnly) client.syncDoc(name, state.doc.toString());
  };
  const textDocument = { uri };

  const completionSource = async (ctx) => {
    const word = ctx.matchBefore(/[\w]*/);
    const trigger = ctx.matchBefore(/[:.(]\s*$|=>\s*$|\s$/);
    if (!ctx.explicit && !word?.text && !trigger) return null;
    sync(ctx.state);
    const res = await client.request("textDocument/completion", { textDocument, position: toPosition(ctx.state.doc, ctx.pos) });
    if (!res?.items?.length) return null;
    return {
      from: word ? word.from : ctx.pos,
      options: res.items.map((it) => ({
        label: it.label,
        detail: it.detail,
        type: KIND_TYPE[it.kind] || "text",
        boost: it.sortText?.startsWith("0") ? 1 : 0,
        apply: it.insertTextFormat === 2 ? snippet(cmSnippet(it.insertText)) : it.insertText ?? it.label,
      })),
      validFor: /^[\w]*$/,
    };
  };

  const goToDefinition = async (view, pos = view.state.selection.main.head) => {
    sync(view.state);
    const loc = await client.request("textDocument/definition", { textDocument, position: toPosition(view.state.doc, pos) });
    if (loc) onNavigate(loc);
    return true;
  };

  const findReferences = (view) => {
    sync(view.state);
    const pos = view.state.selection.main.head;
    const word = view.state.wordAt(pos);
    client.request("textDocument/references", { textDocument, position: toPosition(view.state.doc, pos), context: { includeDeclaration: true } })
      .then((locs) => onReferences(locs || [], word ? view.state.sliceDoc(word.from, word.to) : ""));
    return true;
  };

  const rename = (view) => {
    if (readOnly) return false;
    sync(view.state);
    const position = toPosition(view.state.doc, view.state.selection.main.head);
    client.request("textDocument/prepareRename", { textDocument, position }).then((prep) => {
      if (!prep) return;
      const newName = prompt("Rename symbol to:", prep.placeholder);
      if (!newName || newName === prep.placeholder) return;
      return client.request("textDocument/rename", { textDocument, position, newName }).then((edit) => edit && onRename(edit, view));
    }).catch((e) => alert(e.message));
    return true;
  };

  // Folding ranges and diagnostics arrive asynchronously from the server.
  const serverSync = ViewPlugin.fromClass(class {
    constructor(view) {
      this.view = view;
      this.timer = null;
      this.unsubscribe = client.onDiagnostics((u, diags) => u === uri && this.apply(diags));
      // Show what the server already reported for this file (dispatching inside the constructor is not allowed).
      const cached = client.diagnostics.get(uri);
      if (cached) queueMicrotask(() => this.apply(cached));
      this.refresh();
    }
    apply(diags) {
      if (this.destroyed) return;
      const doc = this.view.state.doc;
      // Ignore results for an older version of the text.
      if (!readOnly && client.docs.get(name)?.text !== doc.toString()) return;
      this.view.dispatch(setDiagnostics(this.view.state, diags.map((d) => ({
        from: toOffset(doc, d.range.start), to: Math.max(toOffset(doc, d.range.start), toOffset(doc, d.range.end)),
        severity: d.severity === 1 ? "error" : d.severity === 2 ? "warning" : "info", message: d.message, source: d.source,
      }))));
    }
    update(u) {
      if (u.docChanged) this.refresh();
    }
    refresh() {
      clearTimeout(this.timer);
      this.timer = setTimeout(async () => {
        sync(this.view.state);
        const ranges = await client.request("textDocument/foldingRange", { textDocument });
        if (this.destroyed) return;
        const doc = this.view.state.doc;
        this.view.dispatch({ effects: setFolds.of((ranges || []).filter((r) => r.endLine < doc.lines).map((r) => ({ from: doc.line(r.startLine + 1).to, to: doc.line(r.endLine + 1).to }))) });
      }, 200);
    }
    destroy() {
      this.destroyed = true;
      clearTimeout(this.timer);
      this.unsubscribe();
    }
  });

  return [
    autocompletion({ override: [completionSource], activateOnTyping: true, icons: true }),
    hoverTooltip(async (view, pos) => {
      sync(view.state);
      const h = await client.request("textDocument/hover", { textDocument, position: toPosition(view.state.doc, pos) });
      if (!h) return null;
      const from = h.range ? toOffset(view.state.doc, h.range.start) : pos;
      const to = h.range ? toOffset(view.state.doc, h.range.end) : pos;
      return { pos: from, end: to, above: true, create: () => ({ dom: renderHover(h.contents.value) }) };
    }, { hoverTime: 350 }),
    foldField,
    foldService.of((state, from, to) => {
      const r = state.field(foldField, false)?.find((f) => f.from >= from && f.from <= to);
      return r ? { from: r.from, to: r.to } : null;
    }),
    foldGutter({
      openText: "⌄",
      closedText: "›",
      // Redraw markers when the server's folding ranges arrive.
      foldingChanged: (u) => u.startState.field(foldField, false) !== u.state.field(foldField, false),
    }),
    keymap.of([
      { key: "F12", run: (v) => (goToDefinition(v), true) },
      { key: "Shift-F12", run: findReferences },
      { key: "F2", run: rename },
      ...completionKeymap,
      ...foldKeymap,
    ]),
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.ctrlKey || e.metaKey) || e.button !== 0) return false;
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos === null) return false;
        e.preventDefault();
        goToDefinition(view, pos);
        return true;
      },
    }),
    serverSync,
  ];
}
