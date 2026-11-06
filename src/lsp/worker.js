// AADL language server: LSP (JSON-RPC 2.0) over postMessage, running in a
// Web Worker so parsing and resolution never block the editor. It uses the
// same core parser, model and plug-ins as the workbench.

import { LanguageService, uriOf, nameOf } from "./service.js";
import { PluginHost } from "../core/plugin-host.js";
import { BUILTIN_PLUGINS } from "../plugins/index.js";
import { CORE_LIBRARIES } from "../core/library.js";

const host = new PluginHost();
for (const p of BUILTIN_PLUGINS) host.register(p);
const service = new LanguageService({ host, libraries: [...CORE_LIBRARIES, ...host.libraries] });
const versions = new Map();

const send = (msg) => self.postMessage({ jsonrpc: "2.0", ...msg });
const notify = (method, params) => send({ method, params });

let publishTimer = null;
function schedulePublish() {
  clearTimeout(publishTimer);
  // Diagnostics are workspace-wide (a change in one file can fix or break another).
  publishTimer = setTimeout(() => {
    for (const name of service.files.keys()) {
      notify("textDocument/publishDiagnostics", { uri: uriOf(name), version: versions.get(name), diagnostics: service.diagnostics(uriOf(name)) });
    }
  }, 120);
}

const requests = {
  initialize: () => ({
    capabilities: {
      textDocumentSync: { openClose: true, change: 1 },
      completionProvider: { triggerCharacters: [":", ".", " ", "("], resolveProvider: false },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      documentSymbolProvider: true,
      foldingRangeProvider: true,
      workspace: { fileOperations: { didRename: { filters: [{ pattern: { glob: "**/*.aadl" } }] }, didDelete: { filters: [{ pattern: { glob: "**/*.aadl" } }] } } },
    },
    serverInfo: { name: "wosate-aadl-language-server", version: "0.3.0" },
  }),
  shutdown: () => null,
  "textDocument/completion": (p) => service.completion(p.textDocument.uri, p.position),
  "textDocument/hover": (p) => service.hover(p.textDocument.uri, p.position),
  "textDocument/definition": (p) => service.definition(p.textDocument.uri, p.position),
  "textDocument/references": (p) => service.references(p.textDocument.uri, p.position, { includeDeclaration: p.context?.includeDeclaration ?? true }),
  "textDocument/prepareRename": (p) => service.prepareRename(p.textDocument.uri, p.position),
  "textDocument/rename": (p) => service.rename(p.textDocument.uri, p.position, p.newName),
  "textDocument/documentSymbol": (p) => service.documentSymbols(p.textDocument.uri),
  "textDocument/foldingRange": (p) => service.foldingRanges(p.textDocument.uri),
};

const notifications = {
  initialized: () => {},
  exit: () => self.close(),
  "textDocument/didOpen": ({ textDocument }) => {
    versions.set(nameOf(textDocument.uri), textDocument.version);
    service.setFile(nameOf(textDocument.uri), textDocument.text);
    schedulePublish();
  },
  "textDocument/didChange": ({ textDocument, contentChanges }) => {
    const last = contentChanges.at(-1);
    versions.set(nameOf(textDocument.uri), textDocument.version);
    service.setFile(nameOf(textDocument.uri), last.text);
    schedulePublish();
  },
  "textDocument/didClose": () => {
    // Workspace semantics: closed files stay part of the model.
  },
  "workspace/didDeleteFiles": ({ files }) => {
    for (const f of files) {
      service.removeFile(nameOf(f.uri));
      notify("textDocument/publishDiagnostics", { uri: f.uri, diagnostics: [] });
    }
    schedulePublish();
  },
  "workspace/didRenameFiles": ({ files }) => {
    for (const f of files) {
      const text = service.text(nameOf(f.oldUri));
      service.removeFile(nameOf(f.oldUri));
      if (text !== null) service.setFile(nameOf(f.newUri), text);
    }
    schedulePublish();
  },
  // WOSATE extensions: mirror the workbench's plug-in state and plug-in libraries.
  "wosate/configure": ({ disabledPlugins = [], libraries }) => {
    for (const { plugin } of host.plugins) host.setEnabled(plugin.id, !disabledPlugins.includes(plugin.id));
    if (libraries) service.setLibraries(libraries);
    else service.setLibraries([...CORE_LIBRARIES, ...host.libraries]);
    schedulePublish();
  },
};

self.onmessage = async ({ data: msg }) => {
  if (!msg || msg.jsonrpc !== "2.0") return;
  if (msg.id !== undefined && msg.method) {
    const handler = requests[msg.method];
    if (!handler) return send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
    try {
      send({ id: msg.id, result: (await handler(msg.params || {})) ?? null });
    } catch (e) {
      send({ id: msg.id, error: { code: -32603, message: e.message } });
    }
    return;
  }
  notifications[msg.method]?.(msg.params || {});
};
