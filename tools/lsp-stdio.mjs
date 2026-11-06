// The WOSATE AADL language server over stdio (Content-Length framed JSON-RPC),
// for desktop editors (VS Code, Neovim, Emacs, …). Same service as the
// in-browser worker; files are read from disk as editors open them.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LanguageService } from "../src/lsp/service.js";
import { PluginHost } from "../src/core/plugin-host.js";
import { BUILTIN_PLUGINS } from "../src/plugins/index.js";
import { CORE_LIBRARIES } from "../src/core/library.js";

const host = new PluginHost();
for (const p of BUILTIN_PLUGINS) host.register(p);
const service = new LanguageService({ host, libraries: [...CORE_LIBRARIES, ...host.libraries] });

// The service names files by URI path; disk files use a canonical file:// URI, libraries their bare name.
// Editors spell the same file differently (file:///d%3A/… vs file:///D:/…), so URIs are normalized first.
const canon = (uri) => {
  try {
    return pathToFileURL(fileURLToPath(uri)).href.replace(/^file:\/\/\/([A-Za-z]):/, (_m, d) => `file:///${d.toLowerCase()}:`);
  } catch {
    return uri;
  }
};
const toServiceUri = (uri) => `file:///${encodeURI(canon(uri))}`;
const fromServiceUri = (uri) => decodeURIComponent(uri.replace(/^file:\/\/\//, ""));
const mapLocations = (v) => {
  if (Array.isArray(v)) return v.map(mapLocations);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if ((k === "uri") && typeof x === "string") out[k] = libraryUri(fromServiceUri(x));
      else if (k === "changes") out[k] = Object.fromEntries(Object.entries(x).map(([u, edits]) => [libraryUri(fromServiceUri(u)), edits]));
      else out[k] = mapLocations(x);
    }
    return out;
  }
  return v;
};
// Library files are virtual: expose them under a wosate: scheme the editor can show read-only.
const libraryUri = (name) => (service.isLibrary(name) ? `wosate-library:///${encodeURI(name)}` : name);

function send(msg) {
  const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

function loadWorkspace(rootUri) {
  if (!rootUri?.startsWith("file:")) return;
  const walk = (p) => {
    for (const e of readdirSync(p)) {
      if (e.startsWith(".") || e === "node_modules") continue;
      const f = join(p, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.aadl2?$/i.test(e)) service.setFile(canon(pathToFileURL(f).href), readFileSync(f, "utf8"));
    }
  };
  try {
    walk(fileURLToPath(rootUri));
  } catch {
    /* unreadable workspace folder: rely on didOpen */
  }
}

let publishTimer = null;
function publish() {
  clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    for (const name of service.files.keys()) send({ method: "textDocument/publishDiagnostics", params: { uri: name, diagnostics: service.diagnostics(toServiceUri(name)) } });
  }, 150);
}

const withUri = (p) => ({ ...p, textDocument: { ...p.textDocument, uri: toServiceUri(p.textDocument.uri) } });
const requests = {
  initialize: (p) => {
    loadWorkspace(p.rootUri || p.workspaceFolders?.[0]?.uri);
    publish();
    return {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1 },
        completionProvider: { triggerCharacters: [":", ".", " ", "("] },
        hoverProvider: true, definitionProvider: true, referencesProvider: true,
        renameProvider: { prepareProvider: true }, documentSymbolProvider: true, foldingRangeProvider: true,
      },
      serverInfo: { name: "wosate-aadl-language-server", version: "0.3.0" },
    };
  },
  shutdown: () => null,
  "textDocument/completion": (p) => service.completion(withUri(p).textDocument.uri, p.position),
  "textDocument/hover": (p) => service.hover(withUri(p).textDocument.uri, p.position),
  "textDocument/definition": (p) => mapLocations(service.definition(withUri(p).textDocument.uri, p.position)),
  "textDocument/references": (p) => mapLocations(service.references(withUri(p).textDocument.uri, p.position, { includeDeclaration: p.context?.includeDeclaration ?? true })),
  "textDocument/prepareRename": (p) => service.prepareRename(withUri(p).textDocument.uri, p.position),
  "textDocument/rename": (p) => mapLocations(service.rename(withUri(p).textDocument.uri, p.position, p.newName)),
  "textDocument/documentSymbol": (p) => service.documentSymbols(withUri(p).textDocument.uri),
  "textDocument/foldingRange": (p) => service.foldingRanges(withUri(p).textDocument.uri),
};
const notifications = {
  "textDocument/didOpen": ({ textDocument }) => (service.setFile(canon(textDocument.uri), textDocument.text), publish()),
  "textDocument/didChange": ({ textDocument, contentChanges }) => (service.setFile(canon(textDocument.uri), contentChanges.at(-1).text), publish()),
  exit: () => process.exit(0),
};

let buffer = Buffer.alloc(0);
process.stdin.on("data", async (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) return;
    const m = /Content-Length: (\d+)/i.exec(buffer.slice(0, headerEnd).toString());
    const len = m ? Number(m[1]) : 0;
    if (buffer.length < headerEnd + 4 + len) return;
    const msg = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + len);
    if (msg.id !== undefined && msg.method) {
      const h = requests[msg.method];
      if (!h) send({ id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      else {
        try {
          send({ id: msg.id, result: (await h(msg.params || {})) ?? null });
        } catch (e) {
          send({ id: msg.id, error: { code: -32603, message: e.message } });
        }
      }
    } else notifications[msg.method]?.(msg.params || {});
  }
});
