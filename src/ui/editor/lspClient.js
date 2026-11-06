// LSP client for the in-browser AADL language server (src/lsp/worker.js).
// It keeps the server's copy of every workspace file in sync and exposes
// request() / notify() plus a diagnostics subscription.

import { uriOf, nameOf } from "../../lsp/service.js";

export { uriOf, nameOf };

export class LspClient {
  constructor() {
    this.worker = new Worker(new URL("../../lsp/worker.js", import.meta.url), { type: "module", name: "aadl-language-server" });
    this.nextId = 1;
    this.pending = new Map();
    this.docs = new Map(); // name -> { version, text }
    this.diagnostics = new Map(); // uri -> Diagnostic[]
    this.listeners = new Set();
    this.worker.onmessage = ({ data }) => this.receive(data);
    this.worker.onerror = (e) => console.error("AADL language server failed", e);
    this.ready = this.request("initialize", { processId: null, rootUri: "file:///", capabilities: {} }).then((r) => {
      this.notify("initialized", {});
      this.capabilities = r.capabilities;
      return r;
    });
  }

  receive(msg) {
    if (msg.id !== undefined && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      this.diagnostics.set(msg.params.uri, msg.params.diagnostics);
      for (const l of this.listeners) l(msg.params.uri, msg.params.diagnostics);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.worker.postMessage({ jsonrpc: "2.0", method, params });
  }

  onDiagnostics(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send didOpen / didChange for one document if the server's copy is out of date. */
  syncDoc(name, text) {
    const doc = this.docs.get(name);
    if (!doc) {
      this.docs.set(name, { version: 1, text });
      this.notify("textDocument/didOpen", { textDocument: { uri: uriOf(name), languageId: "aadl", version: 1, text } });
    } else if (doc.text !== text) {
      doc.version++;
      doc.text = text;
      this.notify("textDocument/didChange", { textDocument: { uri: uriOf(name), version: doc.version }, contentChanges: [{ text }] });
    }
  }

  /** Bring the server's workspace in line with the workbench's file list. */
  syncWorkspace(files) {
    const names = new Set(files.map((f) => f.name));
    const removed = [...this.docs.keys()].filter((n) => !names.has(n));
    if (removed.length) {
      for (const n of removed) this.docs.delete(n);
      this.notify("workspace/didDeleteFiles", { files: removed.map((n) => ({ uri: uriOf(n) })) });
    }
    for (const f of files) this.syncDoc(f.name, f.text);
  }

  configure({ disabledPlugins, libraries }) {
    this.notify("wosate/configure", { disabledPlugins, libraries });
  }
}
