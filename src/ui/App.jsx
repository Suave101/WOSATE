// WOSATE workbench: workspace, editor, model rebuilds, analyses and plug-ins,
// laid out like VS Code (activity bar, side bar, editor group, panel, status bar).

import { useEffect, useMemo, useRef, useState } from "react";
import { PluginHost } from "../core/plugin-host.js";
import { buildModel } from "../core/model.js";
import { instantiate } from "../core/instance.js";
import { CORE_LIBRARIES } from "../core/library.js";
import { BUILTIN_PLUGINS } from "../plugins/index.js";
import { useWorkspace, uniqueName } from "./workspace.js";
import { download } from "./download.js";
import { xmiToJson } from "../core/serialize.js";
import CodeEditor from "./editor/CodeEditor.jsx";
import DiagramCanvas from "./diagram/DiagramCanvas.jsx";
import { LspClient, nameOf } from "./editor/lspClient.js";
import { AnalysisWorker } from "./analysisWorker.js";
import { Collaboration, randomRoom } from "./collab.js";
import { FolderSync, folderSupported, pickFolder, rememberFolder, recallFolder, folderPermission } from "./folder.js";
import { readTheme, resolveTheme, applyTheme, THEMES } from "./theme.js";
import { foldAll, unfoldAll } from "@codemirror/language";
import { startCompletion } from "@codemirror/autocomplete";
import { Menu } from "./components/Menu.jsx";
import { Icon } from "./components/Icon.jsx";
import { QuickPick } from "./components/QuickPick.jsx";
import { ExplorerView, AnalysesView, ExtensionsView, IconButton } from "./components/Sidebar.jsx";
import { ProblemsView, ResultsView } from "./components/Results.jsx";

// The plug-in host is mutable and shared; `pluginRev` tells React when it changed.
const host = new PluginHost();
for (const p of BUILTIN_PLUGINS) host.register(p);
// The AADL language server runs in a Web Worker for the lifetime of the page.
const lsp = new LspClient();
// Built-in analyses run in a worker thread so long runs never block the editor.
const analysisWorker = new AnalysisWorker();

const VIEWS = [
  { id: "explorer", icon: "files", title: "Explorer (Ctrl+Shift+E)" },
  { id: "analyses", icon: "beaker", title: "Analyses (Ctrl+Shift+A)" },
  { id: "extensions", icon: "extensions", title: "Extensions (Ctrl+Shift+X)" },
];

const newFileTemplate = (pkg) => `package ${pkg}
public
  with Base_Types;

  system S
    features
      input: in data port Base_Types::Integer;
      output: out data port Base_Types::Integer;
    annex agree {**
      guarantee "output follows input" : output = input;
    **};
  end S;

end ${pkg};
`;

/** Arrow keys, Home and End move between the tabs of a tablist and activate them. */
function onTabListKey(e) {
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
  if (next === undefined) return;
  e.preventDefault();
  const tab = tabs[(next + tabs.length) % tabs.length];
  tab.focus();
  tab.click();
}

/** Sun (light), moon (dark) or half-filled circle (match system), 16px. */
function ThemeIcon({ theme }) {
  if (theme === "auto") return <Icon name="color-mode" />;
  return theme === "light" ? (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round">
      <path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3z" />
    </svg>
  );
}

async function readFiles(fileList) {
  return Promise.all([...fileList].map(async (f) => ({ name: f.name, text: await f.text() })));
}

export default function App() {
  const [ws, dispatch] = useWorkspace();
  const [pluginRev, setPluginRev] = useState(0);
  const [view, setView] = useState("explorer");
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth > 760);
  const [panelVisible, setPanelVisible] = useState(true);
  const [panel, setPanel] = useState("problems");
  const [quickPick, setQuickPick] = useState(null);
  const [results, setResults] = useState([]);
  const [status, setStatus] = useState({ text: "", busy: false });
  const [gotoReq, setGotoReq] = useState(null);
  const [collab, setCollab] = useState(null);
  const [peers, setPeers] = useState(0);
  const [folder, setFolder] = useState(null);
  const [folderToReconnect, setFolderToReconnect] = useState(null);
  const [theme, setTheme] = useState(readTheme);
  // Re-render when the system theme flips while following it.
  const [, setSystemTick] = useState(0);
  useEffect(() => applyTheme(theme, () => setSystemTick((n) => n + 1)), [theme]);
  const resolvedTheme = resolveTheme(theme);
  const THEME_LABEL = { dark: "Dark", light: "Light", auto: "Match system" };
  const nextTheme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  const editorRef = useRef(null);
  const fileInput = useRef(null);
  const workspaceInput = useRef(null);
  const xmiInput = useRef(null);
  const started = useRef(false);
  const running = useRef(false);

  // Start-up: restore plug-in preferences, load external plug-ins, seed a first example.
  if (!started.current) {
    started.current = true;
    for (const id of ws.disabledPlugins) host.setEnabled(id, false);
  }
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const url of ws.externalPlugins) {
        try {
          await host.loadFromUrl(new URL(url, document.baseURI).href);
        } catch (e) {
          console.error(e);
          setStatus({ text: `Could not load plug-in ${url}: ${e.message}`, busy: false });
        }
      }
      if (!cancelled) setPluginRev((r) => r + 1);
    })();
    if (ws.fresh && !ws.files.length) {
      const first = host.examples.find((e) => e.id === "agree-toy");
      if (first) dispatch({ type: "add", files: first.files, target: first.target, replace: true });
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const libraries = useMemo(() => [...CORE_LIBRARIES, ...host.libraries], [pluginRev]);
  const analyses = useMemo(() => host.analyses, [pluginRev]);
  const examples = useMemo(() => host.examples, [pluginRev]);
  const annexKeywords = useMemo(() => host.editorKeywords, [pluginRev]);

  const { model, buildMs } = useMemo(() => {
    const t0 = performance.now();
    const m = buildModel([...libraries, ...ws.files], host);
    return { model: m, buildMs: performance.now() - t0 };
  }, [libraries, ws.files, pluginRev]);

  const findFile = (name) => ws.files.find((f) => f.name === name) || libraries.find((f) => f.name === name) || null;
  const activeFile = findFile(ws.active);
  // Diagram tabs are `diagram:<Pkg>::<Impl>`.
  const isDiagram = (name) => typeof name === "string" && name.startsWith("diagram:");
  const activeDiagram = isDiagram(ws.active) ? ws.active.slice(8) : null;
  const openDiagram = (qname) => qname && dispatch({ type: "open", name: `diagram:${qname}` });
  const renameMember = async (member) => {
    const file = member.loc.file;
    const f = ws.files.find((x) => x.name === file);
    if (!f) return alert(`${member.name} is declared in a read-only library`);
    const newName = prompt(`Rename '${member.name}' to:`, member.name);
    if (!newName || newName === member.name) return;
    try {
      lsp.syncDoc(file, f.text);
      const edit = await lsp.request("textDocument/rename", { textDocument: { uri: `file:///${encodeURI(file)}` }, position: { line: member.loc.line - 1, character: member.loc.col - 1 }, newName });
      if (edit?.changes) applyWorkspaceEdit(edit.changes);
    } catch (e) {
      alert(e.message);
    }
  };

  const impls = useMemo(() => {
    const list = model.implementations.filter((c) => c.pkg !== "Base_Types");
    list.sort((a, b) => (a.category === "system" ? 0 : 1) - (b.category === "system" ? 0 : 1) || model.qualifiedName(a).localeCompare(model.qualifiedName(b)));
    return list.map((c) => ({ name: model.qualifiedName(c), category: c.category }));
  }, [model]);
  const target = impls.some((i) => i.name === ws.target) ? ws.target : impls[0]?.name ?? null;

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const d of model.diagnostics) if (d.severity in c) c[d.severity]++;
    return c;
  }, [model]);
  const fileSeverity = (name) => {
    const ds = model.diagnostics.filter((d) => d.file === name);
    return ds.some((d) => d.severity === "error") ? "has-errors" : ds.some((d) => d.severity === "warning") ? "has-warnings" : "";
  };

  // ---- navigation ----------------------------------------------------------------------

  const openFile = (name) => (findFile(name) || isDiagram(name)) && dispatch({ type: "open", name });
  const gotoLocation = (loc) => {
    if (!loc?.file || !findFile(loc.file)) return;
    dispatch({ type: "open", name: loc.file });
    setGotoReq({ loc, n: Date.now() });
  };
  // ---- local folder -----------------------------------------------------------------------------

  const attachFolder = async (handle) => {
    folder?.destroy();
    const sync = new FolderSync(handle, {
      onExternal: (files) => {
        dispatch({ type: "replace", files });
        setStatus({ text: `Reloaded changes from ${handle.name} on disk`, busy: false });
      },
      onError: (e) => setStatus({ text: `Could not write to ${handle.name}: ${e.message}`, busy: false }),
      onSaved: (n) => setStatus({ text: `Saved ${n} file${n === 1 ? "" : "s"} to ${handle.name}`, busy: false }),
    });
    const files = await sync.load();
    if (!files.length && ws.files.length && confirm(`'${handle.name}' has no .aadl files. Save the ${ws.files.length} file(s) of the current workspace into it?`)) {
      sync.push(ws.files, 0);
      await sync.flush();
    } else {
      dispatch({ type: "replace", files });
    }
    await rememberFolder(handle);
    setFolder(sync);
    setFolderToReconnect(null);
    setStatus({ text: `Opened folder ${handle.name} (${files.length} AADL file${files.length === 1 ? "" : "s"})`, busy: false });
    return sync;
  };
  const openFolder = async () => {
    if (!folderSupported()) return alert("Opening a folder needs a browser with the File System Access API (Chrome, Edge or another Chromium browser). Use File → Import Files instead.");
    if (ws.files.length && !folder && !confirm("Open a folder? The workspace will show that folder's .aadl files (export the current workspace first if you want to keep it).")) return;
    try {
      await attachFolder(await pickFolder());
    } catch (e) {
      if (e.name !== "AbortError") alert(`Could not open the folder: ${e.message}`);
    }
  };
  const closeFolder = async () => {
    await folder?.flush();
    folder?.destroy();
    setFolder(null);
    await rememberFolder(null);
    setStatus({ text: "Closed the folder; its files stay in the browser workspace", busy: false });
  };
  const reconnectFolder = async () => {
    if (!folderToReconnect) return;
    if ((await folderPermission(folderToReconnect, true)) === "granted") await attachFolder(folderToReconnect);
  };
  // Write local changes (typing, diagram edits, renames, new and deleted files) to disk.
  useEffect(() => {
    folder?.push(ws.files);
  }, [folder, ws.files]);
  // Pick up changes made by other tools while the page is visible.
  useEffect(() => {
    if (!folder) return;
    const t = setInterval(() => document.visibilityState === "visible" && folder.poll(), 2000);
    const onFocus = () => folder.poll();
    const onUnload = () => folder.flush();
    window.addEventListener("focus", onFocus);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [folder]);
  // Reopen the last folder; the browser may ask for permission again (needs a click).
  const folderRestored = useRef(false);
  useEffect(() => {
    if (folderRestored.current) return;
    folderRestored.current = true;
    recallFolder().then(async (handle) => {
      if (!handle) return;
      if ((await folderPermission(handle)) === "granted") attachFolder(handle);
      else setFolderToReconnect(handle);
    });
  }, []);
  if (import.meta.env.DEV) window.__wosateAttachFolder = attachFolder;

  // ---- live collaboration --------------------------------------------------------------------

  const startSession = async (room, password) => {
    collab?.destroy();
    const signaling = (ws.settings.collabSignaling || "").split(/[\s,]+/).filter(Boolean);
    const session = new Collaboration({
      room,
      password,
      signaling,
      user: ws.settings.collabName || "Engineer",
      onFiles: (files) => dispatch({ type: "replace", files }),
      onPeers: setPeers,
    });
    setCollab(session);
    setStatus({ text: `Connecting to session ${room}…`, busy: true });
    const role = await session.start(ws.files);
    setStatus({ text: role === "joined" ? `Joined live session ${room}` : `Hosting live session ${room}`, busy: false });
    history.replaceState(null, "", `${location.pathname}${location.search}#room=${encodeURIComponent(room)}`);
    return session;
  };
  const shareSession = async () => {
    const room = collab?.room || randomRoom();
    if (!collab) {
      const password = prompt(`Start a live session in room '${room}'.\nOptional password (peers need the same one), or leave empty:`, "");
      if (password === null) return;
      await startSession(room, password);
    }
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}#room=${encodeURIComponent(room)}`);
      setStatus({ text: "Session link copied to the clipboard", busy: false });
    } catch {
      prompt("Share this link with collaborators:", `${location.origin}${location.pathname}#room=${encodeURIComponent(room)}`);
    }
  };
  const joinSession = async () => {
    const room = prompt("Room to join (from the session link):", "");
    if (!room) return;
    const password = prompt("Session password (leave empty if none):", "") ?? "";
    if (ws.files.length && !confirm("Joining replaces this workspace with the session's files while you are connected. Export your workspace first if you want to keep a copy. Continue?")) return;
    await startSession(room.replace(/^.*#room=/, ""), password);
  };
  const leaveSession = () => {
    collab?.destroy();
    setCollab(null);
    setPeers(0);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    setStatus({ text: "Left the live session (your workspace keeps the last shared state)", busy: false });
  };
  // Push local changes (typing, diagram edits, renames, imports) into the shared document.
  useEffect(() => {
    collab?.push(ws.files);
  }, [collab, ws.files]);
  // Join from a shared link (#room=...), once.
  const linkJoined = useRef(false);
  useEffect(() => {
    const m = /#room=([^&]+)/.exec(location.hash);
    if (!m || linkJoined.current) return;
    linkJoined.current = true;
    const room = decodeURIComponent(m[1]);
    if (confirm(`Join live session '${room}'? Your workspace will show the session's files while connected.`)) {
      startSession(room, prompt("Session password (leave empty if none):", "") ?? "");
    }
  }, []);
  useEffect(() => () => collab?.destroy(), [collab]);

  // ---- language server ---------------------------------------------------------------------

  useEffect(() => {
    lsp.syncWorkspace(ws.files);
  }, [ws.files]);
  useEffect(() => {
    lsp.configure({ disabledPlugins: [...host.disabled], libraries });
  }, [pluginRev, libraries]);

  const lspLocation = (loc) => ({ file: nameOf(loc.uri), line: loc.range.start.line + 1, col: loc.range.start.character + 1 });
  const applyWorkspaceEdit = (changes) => {
    for (const [uri, edits] of Object.entries(changes)) {
      const name = nameOf(uri);
      const f = ws.files.find((x) => x.name === name);
      if (!f) continue;
      const starts = [0];
      for (let i = 0; i < f.text.length; i++) if (f.text[i] === "\n") starts.push(i + 1);
      const off = (p) => starts[p.line] + p.character;
      let text = f.text;
      for (const e of [...edits].sort((a, b) => off(b.range.start) - off(a.range.start))) {
        text = text.slice(0, off(e.range.start)) + e.newText + text.slice(off(e.range.end));
      }
      dispatch({ type: "edit", name, text });
    }
  };

  useEffect(() => {
    if (gotoReq && gotoReq.loc.file === ws.active) {
      editorRef.current?.goto(gotoReq.loc.line, gotoReq.loc.col);
      setGotoReq(null);
    }
  }, [gotoReq, ws.active]);

  const showView = (id) => {
    if (id === view && sidebarVisible) setSidebarVisible(false);
    else {
      setView(id);
      setSidebarVisible(true);
    }
  };
  const showPanel = (id) => {
    setPanel(id);
    setPanelVisible(true);
  };

  // ---- analyses ---------------------------------------------------------------------------

  const addResult = (result, analysis, forTarget, elapsed) =>
    setResults((r) => [{ id: `${Date.now()}-${r.length}`, result, analysis, target: forTarget, time: new Date(), elapsed }, ...r]);

  const runAnalysis = async (analysis) => {
    if (running.current) return;
    showPanel("results");
    const impl = target ? model.findByQualifiedName(target) : null;
    const ctx = { model, impl, settings: ws.settings, libraryFiles: new Set(libraries.map((l) => l.name)), progress: (text) => setStatus({ text, busy: true }), services: {} };
    if (analysis.scope !== "model") {
      if (!impl) return addResult({ status: "error", summary: "Select a component implementation first.", sections: [] }, analysis, null, 0);
      if (counts.error) {
        showPanel("problems");
        return addResult({ status: "error", summary: `The model has ${counts.error} error${counts.error > 1 ? "s" : ""}; fix them before running ${analysis.label}.`, sections: [] }, analysis, target, 0);
      }
      const { root, problems } = instantiate(model, impl);
      ctx.instance = root;
      ctx.instanceProblems = problems;
    }
    running.current = true;
    setStatus({ text: `Running ${analysis.label}…`, busy: true });
    const t0 = performance.now();
    const forTarget = analysis.scope === "model" ? null : target;
    try {
      const builtin = host.plugins.find((p) => p.plugin === analysis.plugin)?.source === "built-in";
      if (builtin && !analysis.mainThread) {
        const { result } = await analysisWorker.run(
          { key: analysis.key, files: ws.files, libraries, target, settings: ws.settings, disabledPlugins: [...host.disabled] },
          { onProgress: (text) => setStatus({ text, busy: true }) },
        );
        addResult(result, analysis, forTarget, performance.now() - t0);
      } else {
        addResult(await analysis.run(ctx), analysis, forTarget, performance.now() - t0);
      }
    } catch (e) {
      console.error(e);
      addResult({ status: "error", summary: e.message, sections: [{ title: "Details", text: e.stack || String(e) }] }, analysis, forTarget, performance.now() - t0);
    } finally {
      running.current = false;
      setStatus({ text: "", busy: false });
    }
  };
  const verifyAgree = analyses.find((a) => a.key === "agree:verify-single");

  // ---- workspace actions --------------------------------------------------------------------

  const newFile = () => {
    const raw = prompt("New AADL file name (the package gets the same name):", "My_Package.aadl");
    if (!raw) return;
    const name = uniqueName([...ws.files, ...libraries], raw.endsWith(".aadl") ? raw : `${raw}.aadl`);
    dispatch({ type: "add", files: [{ name, text: newFileTemplate(name.replace(/\.aadl$/, "").replace(/\W/g, "_")) }] });
  };
  const renameFile = (from) => {
    const to = prompt("Rename file to:", from);
    if (!to || to === from) return;
    if (findFile(to)) return alert(`A file named '${to}' already exists.`);
    dispatch({ type: "rename", from, to });
  };
  const deleteFile = (name) => {
    if (confirm(`Delete '${name}' from the workspace? This cannot be undone (export the workspace first to keep a copy).`)) dispatch({ type: "delete", name });
  };
  const loadExample = (ex) => {
    const clash = ex.files.filter((f) => ws.files.some((x) => x.name === f.name));
    if (clash.length && !confirm(`Replace the existing files ${clash.map((f) => f.name).join(", ")} with the example versions?`)) return;
    dispatch({ type: "add", files: ex.files, replace: true, target: ex.target, open: ex.files.at(-1).name });
  };
  const importFiles = async (list) => {
    const files = await readFiles(list);
    if (files.length) dispatch({ type: "add", files });
  };
  const importWorkspace = async (file) => {
    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.files)) throw new Error("No 'files' array");
      const files = data.files.filter((f) => typeof f.name === "string" && typeof f.text === "string");
      if (confirm(`Import ${files.length} files? Files with the same name are replaced.`)) dispatch({ type: "add", files, replace: true, open: files[0]?.name });
    } catch (e) {
      alert(`Not a WOSATE workspace file: ${e.message}`);
    }
  };
  const exportWorkspace = () =>
    download("wosate-workspace.json", JSON.stringify({ format: "wosate-workspace", version: 1, files: ws.files }, null, 2), "application/json");
  const clearWorkspace = () => confirm("Remove every file from the workspace? Export it first if you want to keep it.") && dispatch({ type: "clear" });

  // ---- plug-ins -----------------------------------------------------------------------------

  const pluginsChanged = (external) => {
    dispatch({ type: "plugins", disabled: [...host.disabled], external });
    setPluginRev((r) => r + 1);
  };
  const togglePlugin = (id, enabled) => {
    host.setEnabled(id, enabled);
    pluginsChanged();
  };
  const removePlugin = (id, source) => {
    host.unregister(id);
    pluginsChanged(ws.externalPlugins.filter((u) => new URL(u, document.baseURI).href !== source));
  };
  const loadPlugin = async (url) => {
    const plugin = await host.loadFromUrl(new URL(url, document.baseURI).href);
    pluginsChanged(ws.externalPlugins.includes(url) ? ws.externalPlugins : [...ws.externalPlugins, url]);
    setStatus({ text: `Installed plug-in ${plugin.name || plugin.id}`, busy: false });
  };

  // ---- commands ---------------------------------------------------------------------------------

  const commands = [
    { id: "file.new", kind: "File", label: "New AADL File…", icon: "new-file", run: newFile },
    { id: "file.openFolder", kind: "File", label: "Open Folder…", detail: "edit .aadl files on disk", icon: "folder-opened", run: openFolder },
    ...(folder ? [{ id: "file.closeFolder", kind: "File", label: `Close Folder (${folder.name})`, icon: "close-all", run: closeFolder }] : []),
    ...(folderToReconnect ? [{ id: "file.reconnect", kind: "File", label: `Reconnect Folder ${folderToReconnect.name}`, icon: "plug", run: reconnectFolder }] : []),
    { id: "file.import", kind: "File", label: "Import Files…", icon: "cloud-upload", run: () => fileInput.current.click() },
    { id: "file.download", kind: "File", label: "Download Current File", icon: "cloud-download", run: () => activeFile && download(activeFile.name, activeFile.text) },
    { id: "ws.export", kind: "Workspace", label: "Export Workspace (.json)", icon: "export", run: exportWorkspace },
    { id: "ws.import", kind: "Workspace", label: "Import Workspace (.json)…", icon: "folder-opened", run: () => workspaceInput.current.click() },
    { id: "file.xmi", kind: "File", label: "Convert EMF XMI (.aadl2 / .aaxl2) to JSON…", icon: "json", run: () => xmiInput.current.click() },
    { id: "ws.clear", kind: "Workspace", label: "Clear Workspace…", icon: "clear-all", run: clearWorkspace },
    { id: "view.explorer", kind: "View", label: "Show Explorer", icon: "files", run: () => { setView("explorer"); setSidebarVisible(true); } },
    { id: "view.analyses", kind: "View", label: "Show Analyses", icon: "beaker", run: () => { setView("analyses"); setSidebarVisible(true); } },
    { id: "view.extensions", kind: "View", label: "Show Extensions", icon: "extensions", run: () => { setView("extensions"); setSidebarVisible(true); } },
    { id: "view.sidebar", kind: "View", label: "Toggle Primary Side Bar Visibility", detail: "Ctrl+B", icon: "layout-sidebar-left", run: () => setSidebarVisible((v) => !v) },
    { id: "view.panel", kind: "View", label: "Toggle Panel Visibility", detail: "Ctrl+J", icon: "layout-panel", run: () => setPanelVisible((v) => !v) },
    ...THEMES.map((t) => ({ id: `theme.${t}`, kind: "Theme", label: `Color Theme: ${THEME_LABEL[t]}`, detail: t === theme ? "current" : "", icon: "color-mode", run: () => setTheme(t) })),
    { id: "collab.share", kind: "Live Share", label: collab ? "Copy Session Link" : "Start Live Session and Copy Link…", icon: "live-share", run: shareSession },
    { id: "collab.join", kind: "Live Share", label: "Join Live Session…", icon: "plug", run: joinSession },
    ...(collab ? [{ id: "collab.leave", kind: "Live Share", label: "Leave Live Session", icon: "debug-disconnect", run: leaveSession }] : []),
    { id: "view.problems", kind: "View", label: "Focus Problems", detail: "Ctrl+Shift+M", icon: "warning", run: () => showPanel("problems") },
    { id: "editor.foldAll", kind: "Editor", label: "Fold All", icon: "fold", run: () => editorRef.current?.view && foldAll(editorRef.current.view) },
    { id: "editor.unfoldAll", kind: "Editor", label: "Unfold All", icon: "unfold", run: () => editorRef.current?.view && unfoldAll(editorRef.current.view) },
    { id: "editor.suggest", kind: "Editor", label: "Trigger Suggest", detail: "Ctrl+Space", icon: "lightbulb", run: () => editorRef.current?.view && (editorRef.current.view.focus(), startCompletion(editorRef.current.view)) },
    { id: "editor.help", kind: "Editor", label: "Go to Definition / Find References / Rename", detail: "F12 · Shift+F12 · F2 (in the editor)", icon: "info", run: () => editorRef.current?.view?.focus() },
    { id: "target.pick", kind: "Target", label: "Select Implementation…", icon: "target", run: () => setQuickPick("target") },
    { id: "diagram.open", kind: "Diagram", label: "Open Diagram of Target Implementation", icon: "type-hierarchy", run: () => openDiagram(target) },
    ...impls.map((i) => ({ id: `diagram.${i.name}`, kind: "Diagram", label: `Open Diagram: ${i.name}`, icon: "type-hierarchy", run: () => openDiagram(i.name) })),
    ...analyses.map((a) => ({ id: `run.${a.key}`, kind: a.plugin.name, label: a.label, detail: a.key === "agree:verify-single" ? "F5" : a.description, icon: "play", run: () => runAnalysis(a) })),
    ...examples.map((ex) => ({ id: `ex.${ex.id}`, kind: "Example", label: `Open Example: ${ex.name}`, icon: "book", run: () => loadExample(ex) })),
  ];
  const referenceItems = () => quickPick.locs.map((loc, i) => {
    const l = lspLocation(loc);
    const lineText = (findFile(l.file)?.text.split("\n")[l.line - 1] || "").trim();
    return { id: `${i}`, label: lineText || l.file, detail: `${l.file}:${l.line}`, icon: "references", run: () => gotoLocation(l) };
  });
  const quickPickProps = quickPick?.kind === "references"
    ? { placeholder: `${quickPick.locs.length} reference${quickPick.locs.length === 1 ? "" : "s"} to '${quickPick.word}'`, items: referenceItems() }
    : quickPick === "files"
    ? { placeholder: "Search files by name", items: [...ws.files, ...libraries].map((f) => ({ id: f.name, label: f.name, detail: f.readOnly ? "plug-in library" : "", icon: f.readOnly ? "library" : "file-code", run: () => openFile(f.name) })) }
    : quickPick === "target"
      ? { placeholder: "Select the component implementation to analyse", items: impls.map((i) => ({ id: i.name, label: i.name, kind: i.category, icon: i.name === target ? "check" : "symbol-class", run: () => dispatch({ type: "target", target: i.name }) })) }
      : quickPick === "commands"
        ? { placeholder: "Type the name of a command to run", items: commands }
        : null;

  // Keep the latest handlers reachable from the window-level shortcut listener.
  const shortcuts = useRef(null);
  shortcuts.current = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const act = (fn) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };
    if (mod && e.shiftKey && key === "p") act(() => setQuickPick("commands"));
    else if (e.key === "F1") act(() => setQuickPick("commands"));
    else if (mod && !e.shiftKey && key === "p") act(() => setQuickPick("files"));
    else if (mod && !e.shiftKey && key === "b") act(() => setSidebarVisible((v) => !v));
    else if (mod && !e.shiftKey && key === "j") act(() => setPanelVisible((v) => !v));
    else if (mod && e.shiftKey && key === "e") act(() => { setView("explorer"); setSidebarVisible(true); });
    else if (mod && e.shiftKey && key === "a") act(() => { setView("analyses"); setSidebarVisible(true); });
    else if (mod && e.shiftKey && key === "x") act(() => { setView("extensions"); setSidebarVisible(true); });
    else if (mod && e.shiftKey && key === "m") act(() => showPanel("problems"));
    else if (e.key === "F5" && verifyAgree) act(() => runAnalysis(verifyAgree));
  };
  useEffect(() => {
    const onKey = (e) => shortcuts.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const fileMenu = [
    { label: "New AADL File…", onSelect: newFile },
    { label: "Open Folder…", description: folderSupported() ? "Edit the .aadl files of a folder on disk" : "Needs Chrome or Edge", onSelect: openFolder },
    ...(folder ? [{ label: `Close Folder (${folder.name})`, onSelect: closeFolder }] : []),
    ...(folderToReconnect ? [{ label: `Reconnect Folder ${folderToReconnect.name}`, onSelect: reconnectFolder }] : []),
    { separator: true },
    { label: "Import Files…", onSelect: () => fileInput.current.click() },
    { label: "Download Current File", onSelect: () => activeFile && download(activeFile.name, activeFile.text) },
    { separator: true },
    { label: "Export Workspace (.json)", onSelect: exportWorkspace },
    { label: "Import Workspace (.json)…", onSelect: () => workspaceInput.current.click() },
    { label: "Convert EMF XMI (.aadl2 / .aaxl2) to JSON…", onSelect: () => xmiInput.current.click() },
    { separator: true },
    { label: "Clear Workspace…", onSelect: clearWorkspace },
  ];
  const analysesMenu = [...Map.groupBy(analyses, (a) => a.plugin.name)].flatMap(([group, list]) => [
    { group },
    ...list.map((a) => ({ label: a.label, description: a.description, onSelect: () => runAnalysis(a) })),
  ]);
  const viewMenu = [
    { label: "Command Palette…  Ctrl+Shift+P", onSelect: () => setQuickPick("commands") },
    { label: "Go to File…  Ctrl+P", onSelect: () => setQuickPick("files") },
    { separator: true },
    { label: "Explorer  Ctrl+Shift+E", onSelect: () => { setView("explorer"); setSidebarVisible(true); } },
    { label: "Analyses  Ctrl+Shift+A", onSelect: () => { setView("analyses"); setSidebarVisible(true); } },
    { label: "Extensions  Ctrl+Shift+X", onSelect: () => { setView("extensions"); setSidebarVisible(true); } },
    { separator: true },
    { label: "Toggle Side Bar  Ctrl+B", onSelect: () => setSidebarVisible((v) => !v) },
    { label: "Toggle Panel  Ctrl+J", onSelect: () => setPanelVisible((v) => !v) },
  ];

  const packagesInFile = activeFile ? [...model.packages.values()].filter((p) => p.file === activeFile.name) : [];
  const viewTitle = VIEWS.find((v) => v.id === view).title.replace(/ \(.*\)$/, "");

  // ---- render -----------------------------------------------------------------------------------

  return (
    <div className="app">
      <a className="skip-link" href="#editor-area" onClick={(e) => { e.preventDefault(); editorRef.current?.view?.focus(); }}>Skip to editor</a>
      <header className="titlebar">
        <h1 className="sr-only">WOSATE Workbench</h1>
        <div className="titlebar-left">
          <span className="app-icon" title="WOSATE"><img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width="18" height="18" /></span>
          <Menu label="File" items={fileMenu} />
          <Menu label="View" items={viewMenu} />
          <Menu label="Analyses" items={analysesMenu} />
          <Menu label="Examples" items={examples.map((ex) => ({ label: ex.name, description: ex.description, onSelect: () => loadExample(ex) }))} />
        </div>
        <button type="button" className="command-center" onClick={() => setQuickPick("commands")} title="Command Palette (Ctrl+Shift+P)">
          <Icon name="search" />
          <span>WOSATE{target ? ` — ${target}` : ""}</span>
        </button>
        <div className="titlebar-right">
          <button
            type="button"
            className="theme-toggle"
            title={`Theme: ${THEME_LABEL[theme]} — click for ${THEME_LABEL[nextTheme]}`}
            aria-label={`Colour theme: ${THEME_LABEL[theme]}. Switch to ${THEME_LABEL[nextTheme]}`}
            onClick={() => setTheme(nextTheme)}
          >
            <ThemeIcon theme={theme} />
          </button>
        </div>
      </header>

      <div className={`workbench${sidebarVisible ? "" : " no-sidebar"}`}>
        <nav className="activitybar" aria-label="Views">
          <div>
            {VIEWS.map((v) => (
              <button key={v.id} type="button" title={v.title} aria-label={v.title} aria-pressed={view === v.id && sidebarVisible} className={view === v.id && sidebarVisible ? "active" : ""} onClick={() => showView(v.id)}>
                <Icon name={v.icon} />
                {v.id === "explorer" && counts.error ? <span className="activity-badge">{counts.error}</span> : null}
              </button>
            ))}
          </div>
          <div>
            <button type="button" title="Command Palette (Ctrl+Shift+P)" aria-label="Command Palette" onClick={() => setQuickPick("commands")}><Icon name="settings-gear" /></button>
          </div>
        </nav>

        <aside
          className="sidebar"
          aria-label={viewTitle}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
          }}
        >
          <div className="sidebar-title">
            <span>{viewTitle}</span>
            {view === "analyses" && verifyAgree ? <IconButton icon="play" title="AGREE: Verify Single Layer (F5)" onClick={() => runAnalysis(verifyAgree)} /> : null}
          </div>
          <div className="sidebar-body">
            {view === "explorer" ? (
              <ExplorerView
                files={ws.files}
                libraries={libraries}
                active={ws.active}
                diagnostics={model.diagnostics}
                model={model}
                onOpen={openFile}
                onNew={newFile}
                onImport={() => fileInput.current.click()}
                onOpenFolder={openFolder}
                folderName={folder?.name}
                onRename={renameFile}
                onDelete={deleteFile}
                onLocation={gotoLocation}
              />
            ) : view === "analyses" ? (
              <AnalysesView
                analyses={analyses}
                impls={impls}
                target={target}
                onTarget={(t) => dispatch({ type: "target", target: t })}
                onRun={runAnalysis}
                examples={examples}
                onExample={loadExample}
                busy={status.busy}
              />
            ) : (
              <ExtensionsView
                host={host}
                settings={ws.settings}
                onToggle={togglePlugin}
                onRemove={removePlugin}
                onLoad={loadPlugin}
                onSettings={(settings) => dispatch({ type: "settings", settings })}
              />
            )}
          </div>
        </aside>

        <main className={`editor-group${panelVisible ? "" : " no-panel"}`}>
          <div className="tabbar">
            <div className="tabs" role="tablist" aria-label="Open editors" onKeyDown={onTabListKey}>
              {ws.open.filter((n) => findFile(n) || isDiagram(n)).map((name) => (
                <div
                  key={name}
                  role="none"
                  className={`tab ${isDiagram(name) ? "" : fileSeverity(name)}${name === ws.active ? " active" : ""}`}
                  onAuxClick={(e) => e.button === 1 && dispatch({ type: "close", name })}
                >
                  <button
                    type="button"
                    role="tab"
                    className="tab-main"
                    aria-keyshortcuts="Delete"
                    onKeyDown={(e) => e.key === "Delete" && (e.preventDefault(), dispatch({ type: "close", name }))}
                    aria-selected={name === ws.active}
                    aria-controls="editor-area"
                    tabIndex={name === ws.active ? 0 : -1}
                    title={isDiagram(name) ? `Diagram of ${name.slice(8)}` : name}
                    aria-label={`${isDiagram(name) ? `Diagram of ${name.slice(8)}` : name}${findFile(name)?.readOnly ? ", read-only" : ""}${{ "has-errors": ", has errors", "has-warnings": ", has warnings" }[isDiagram(name) ? "" : fileSeverity(name)] || ""}`}
                    onClick={() => openFile(name)}
                  >
                  {isDiagram(name) ? (
                    <>
                      <Icon name="type-hierarchy" className="ico-impl" />
                      <span className="label">{name.slice(8).split("::").pop()}</span>
                      <span className="ro">diagram</span>
                    </>
                  ) : (
                    <>
                      <Icon name={findFile(name).readOnly ? "library" : "file-code"} className={findFile(name).readOnly ? "ico-lib" : "ico-file"} />
                      <span className="label">{name}</span>
                      {findFile(name).readOnly ? <span className="ro">read-only</span> : null}
                    </>
                  )}
                  </button>
                  <button type="button" className="close" title="Close (Delete)" aria-hidden="true" tabIndex={-1} onClick={(e) => { e.stopPropagation(); dispatch({ type: "close", name }); }}>
                    <Icon name="close" />
                  </button>
                </div>
              ))}
            </div>
            <div className="editor-actions">
              {verifyAgree ? <IconButton icon="play" className="run" title="AGREE: Verify Single Layer (F5)" onClick={() => runAnalysis(verifyAgree)} /> : null}
              <IconButton icon="run-all" title="AGREE: Verify All Layers" onClick={() => { const a = analyses.find((x) => x.key === "agree:verify-all"); if (a) runAnalysis(a); }} />
              <IconButton icon="type-hierarchy" title="Open Diagram of the target implementation" onClick={() => openDiagram(target)} />
              <IconButton icon="layout-panel" title="Toggle Panel (Ctrl+J)" onClick={() => setPanelVisible((v) => !v)} />
            </div>
          </div>
          <div className="breadcrumbs" aria-label="Breadcrumbs">
            {activeDiagram ? (
              <>
                <span className="crumb"><Icon name="package" className="ico-pkg" />{activeDiagram.split("::")[0]}</span>
                <span className="crumb"><Icon name="chevron-right" className="sep" /><Icon name="type-hierarchy" className="ico-impl" />{activeDiagram.split("::").pop()}</span>
              </>
            ) : null}
            {activeFile ? (
              <>
                <span className="crumb"><Icon name={activeFile.readOnly ? "library" : "file-code"} className={activeFile.readOnly ? "ico-lib" : "ico-file"} />{activeFile.name}</span>
                {packagesInFile.map((p) => (
                  <span key={p.name} className="crumb" role="button" tabIndex={0} onClick={() => gotoLocation(p.loc)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), gotoLocation(p.loc))}>
                    <Icon name="chevron-right" className="sep" /><Icon name="package" className="ico-pkg" />{p.name}
                  </span>
                ))}
              </>
            ) : null}
          </div>
          <div className="editor-area" id="editor-area" role="tabpanel" aria-label={activeDiagram ? `Diagram of ${activeDiagram}` : activeFile ? `Editor: ${activeFile.name}` : "Editor"}>
            <CodeEditor
              ref={editorRef}
              file={activeFile}
              client={lsp}
              collab={collab}
              annexKeywords={annexKeywords}
              onChange={(name, text) => ws.files.some((f) => f.name === name) && dispatch({ type: "edit", name, text })}
              onNavigate={(loc) => gotoLocation(lspLocation(loc))}
              onReferences={(locs, word) => setQuickPick({ kind: "references", locs, word })}
              onWorkspaceEdit={applyWorkspaceEdit}
            />
            {activeDiagram ? (
              <DiagramCanvas
                colorMode={resolvedTheme}
                model={model}
                qname={activeDiagram}
                diagnostics={model.diagnostics}
                getText={(name) => ws.files.find((f) => f.name === name)?.text}
                onEditFile={(name, text) => dispatch({ type: "edit", name, text })}
                onOpenImpl={openDiagram}
                onNavigate={gotoLocation}
                onRename={renameMember}
              />
            ) : null}
            {!activeFile && !activeDiagram ? (
              <div className="welcome">
                <div>
                  <img className="welcome-logo" src={`${import.meta.env.BASE_URL}logo.svg`} alt="WOSATE" width="112" height="112" />
                  <dl>
                    <dt>Show All Commands</dt><dd><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd></dd>
                    <dt>Go to File</dt><dd><kbd>Ctrl</kbd>+<kbd>P</kbd></dd>
                    <dt>Verify AGREE</dt><dd><kbd>F5</kbd></dd>
                    <dt>Toggle Panel</dt><dd><kbd>Ctrl</kbd>+<kbd>J</kbd></dd>
                  </dl>
                </div>
              </div>
            ) : null}
          </div>
          <section className="panel" aria-label="Panel">
            <div className="panel-head">
              <div className="panel-tabs" role="tablist" aria-label="Panel views" onKeyDown={onTabListKey}>
                <button type="button" role="tab" id="tab-problems" aria-controls="panel-body" tabIndex={panel === "problems" ? 0 : -1} aria-selected={panel === "problems"} className={`panel-tab${panel === "problems" ? " active" : ""}`} onClick={() => setPanel("problems")}>
                  Problems {counts.error + counts.warning ? <span className="count-badge" aria-label={`${counts.error + counts.warning} problems`}>{counts.error + counts.warning}</span> : null}
                </button>
                <button type="button" role="tab" id="tab-results" aria-controls="panel-body" tabIndex={panel === "results" ? 0 : -1} aria-selected={panel === "results"} className={`panel-tab${panel === "results" ? " active" : ""}`} onClick={() => setPanel("results")}>
                  Analysis Results {results.length ? <span className="count-badge" aria-label={`${results.length} results`}>{results.length}</span> : null}
                </button>
              </div>
              <span className="panel-status" role="status" aria-live="polite">
                {status.busy ? <Icon name="loading" className="spin" /> : null}
                {status.text}
                {status.busy ? <IconButton icon="debug-stop" title="Cancel analysis" onClick={() => analysisWorker.cancel()} /> : null}
              </span>
              <span className="panel-actions">
                {panel === "results" && results.length ? <IconButton icon="clear-all" title="Clear Results" onClick={() => setResults([])} /> : null}
                <IconButton icon="close" title="Close Panel" onClick={() => setPanelVisible(false)} />
              </span>
            </div>
            <div className="panel-body" id="panel-body" role="tabpanel" aria-labelledby={panel === "problems" ? "tab-problems" : "tab-results"} tabIndex={0}>
              {panel === "problems"
                ? <ProblemsView diagnostics={model.diagnostics} onLocation={gotoLocation} />
                : <ResultsView entries={results} onLocation={gotoLocation} />}
            </div>
          </section>
        </main>
      </div>

      <footer className="statusbar">
        <div className="side">
          <span className="status-item remote" title="WOSATE: Web OSATE"><Icon name="symbol-structure" />WOSATE</span>
          {folder ? (
            <button type="button" className="status-item" title={`Editing files in the folder ${folder.name}. Click to close it.`} onClick={closeFolder}><Icon name="folder-opened" />{folder.name}</button>
          ) : folderToReconnect ? (
            <button type="button" className="status-item warn-bg" title="The browser needs your permission again to edit this folder" onClick={reconnectFolder}><Icon name="folder" />Reconnect {folderToReconnect.name}</button>
          ) : null}
          <button type="button" className={`status-item${collab ? " live" : ""}`} title={collab ? `Live session ${collab.room}: ${collab.peers().map((p) => p.name + (p.self ? " (you)" : "")).join(", ")}. Click to copy the link.` : "Start a live co-editing session"} onClick={shareSession}>
            <Icon name="live-share" />{collab ? `${collab.room} · ${peers} online` : "Live Share"}
          </button>
          <button type="button" className="status-item" title={`${counts.error} errors, ${counts.warning} warnings`} onClick={() => showPanel("problems")}>
            <Icon name="error" />{counts.error}<Icon name="warning" />{counts.warning}
          </button>
          {status.busy ? <span className="status-item"><Icon name="sync" className="spin" />{status.text}</span> : null}
        </div>
        <div className="side">
          <button type="button" className="status-item" title="Select Implementation" onClick={() => setQuickPick("target")}>
            <Icon name="target" />{target ?? "No implementation"}
          </button>
          <span className="status-item hide-narrow" title={window.crossOriginIsolated ? "Z3 (WebAssembly) solver available" : "Z3 needs cross-origin isolation — reload the page; AGREE export still works"}>
            <Icon name={window.crossOriginIsolated ? "check" : "circle-slash"} />Z3
          </span>
          <span className="status-item hide-narrow" title="Model build time">{`${model.packages.size} packages · ${buildMs.toFixed(0)} ms`}</span>
          <span className="status-item hide-narrow">AADL</span>
          <a className="status-item" href="https://github.com/Suave101/WOSATE" target="_blank" rel="noopener noreferrer" title="Source on GitHub"><Icon name="github" /></a>
        </div>
      </footer>

      {quickPickProps ? <QuickPick key={quickPick?.kind || quickPick} {...quickPickProps} onClose={() => setQuickPick(null)} /> : null}
      <input ref={fileInput} type="file" multiple accept=".aadl,.aadl2,.txt" hidden onChange={(e) => { importFiles(e.target.files); e.target.value = ""; }} />
      <input ref={xmiInput} type="file" accept=".aadl2,.aaxl2,.xmi,.xml" hidden onChange={async (e) => {
        const f = e.target.files[0];
        e.target.value = "";
        if (!f) return;
        try {
          download(`${f.name}.json`, JSON.stringify(xmiToJson(await f.text()), null, 2), "application/json");
        } catch (err) {
          alert(`Could not read ${f.name} as XMI: ${err.message}`);
        }
      }} />
      <input ref={workspaceInput} type="file" accept=".json" hidden onChange={(e) => { if (e.target.files[0]) importWorkspace(e.target.files[0]); e.target.value = ""; }} />
    </div>
  );
}
