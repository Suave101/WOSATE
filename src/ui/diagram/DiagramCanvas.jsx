// Graphical architecture canvas for one component implementation, built on
// React Flow. The diagram is derived from the model on every change, and every
// canvas edit (connect, delete, drop a classifier) is written back to the AADL
// text through AST-positioned edits, so text and diagram stay in sync.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, Handle, Position, ConnectionMode, MarkerType,
  useReactFlow, applyNodeChanges, applyEdgeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { addConnection, addSubcomponent, removeMembers, connectionKind, uniqueName } from "../../core/edits.js";
import { Icon } from "../components/Icon.jsx";

const lc = (s) => (s || "").toLowerCase();
const LAYOUT_KEY = (q) => `wosate:layout:${q}`;
const COL_W = 300, ROW_GAP = 40, PORT_ROW = 22, HEAD = 46;
// Handle id for a shared resource (bus, memory, data) that access connections attach to directly.
const SELF = "__self";
const SHARED = new Set(["bus", "virtual bus", "memory", "data", "subprogram", "subprogram group"]);

const CATEGORY_ICON = {
  system: "server-environment", process: "server-process", thread: "pulse", "thread group": "layers", processor: "chip",
  "virtual processor": "chip", memory: "database", bus: "plug", "virtual bus": "plug", device: "device-desktop",
  data: "symbol-variable", subprogram: "symbol-method", abstract: "symbol-misc",
};

function loadLayout(q) {
  try {
    // Layouts saved before the rename from WOWATE are still read.
    return JSON.parse(localStorage.getItem(LAYOUT_KEY(q)) || localStorage.getItem(`wowate:layout:${q}`) || "{}");
  } catch {
    return {};
  }
}

function saveLayout(q, layout) {
  try {
    localStorage.setItem(LAYOUT_KEY(q), JSON.stringify(layout));
  } catch {
    /* storage unavailable: layout is kept for this session only */
  }
}

const side = (f) => {
  if (/access/.test(f.featureKind || "")) return "access";
  if (f.direction === "in") return "in";
  if (f.direction === "out") return "out";
  return "inout";
};

// ---- nodes -----------------------------------------------------------------------------------

const ComponentNode = memo(function ComponentNode({ data, selected }) {
  const ins = data.features.filter((f) => side(f) === "in" || side(f) === "inout");
  const outs = data.features.filter((f) => side(f) === "out" || side(f) === "inout");
  const access = data.features.filter((f) => side(f) === "access");
  const rows = Math.max(ins.length, outs.length, 1);
  return (
    <div className={`aadl-node cat-${data.category.replace(/\s+/g, "-")}${selected ? " selected" : ""}${data.problem ? " has-problem" : ""}`} style={{ minHeight: HEAD + rows * PORT_ROW + (access.length ? 26 : 8) }}>
      <div className="aadl-node-head" title={data.title}>
        <Icon name={CATEGORY_ICON[data.category] || "symbol-misc"} />
        <span className="name">{data.name}</span>
        {data.hasImpl ? <Icon name="go-to-file" className="drill" title="Double-click to open this implementation" /> : null}
      </div>
      <div className="aadl-node-class">{data.category}{data.classifier ? ` ${data.classifier}` : ""}</div>
      {ins.map((f, i) => (
        <div key={`i-${f.name}`} className="aadl-port in" style={{ top: HEAD + i * PORT_ROW }}>
          <Handle type="target" position={Position.Left} id={side(f) === "inout" ? `${f.name}~in` : f.name} className={`port-handle ${/event/.test(f.featureKind || "") ? "event" : ""}`} />
          <span>{f.name}</span>
        </div>
      ))}
      {outs.map((f, i) => (
        <div key={`o-${f.name}`} className="aadl-port out" style={{ top: HEAD + i * PORT_ROW }}>
          <span>{f.name}</span>
          <Handle type="source" position={Position.Right} id={side(f) === "inout" ? `${f.name}~out` : f.name} className={`port-handle ${/event/.test(f.featureKind || "") ? "event" : ""}`} />
        </div>
      ))}
      {access.map((f, i) => (
        <Handle key={`a-${f.name}`} type="source" position={Position.Bottom} id={f.name} className="port-handle access" style={{ left: `${((i + 1) / (access.length + 1)) * 100}%` }} title={`${f.name}: ${f.access} ${f.featureKind}`} />
      ))}
      {access.length ? <div className="aadl-access-labels">{access.map((f) => <span key={f.name}>{f.name}</span>)}</div> : null}
      {SHARED.has(data.category) ? <Handle type="source" position={Position.Top} id={SELF} className="port-handle access self" title={`Connect access features to ${data.name}`} /> : null}
      {data.calls?.length ? (
        <div className="aadl-calls" style={{ marginTop: rows * PORT_ROW + 4 }}>
          {data.calls.map((seq) => (
            <div key={seq.name}>
              <span className="seq">{seq.name}:</span> {seq.calls.map((c) => c.name + (c.classifier ? ` → ${c.classifier.name}` : "")).join(", ")}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
});

const PortNode = memo(function PortNode({ data, selected }) {
  const s = side(data.feature);
  // Outer features: data enters from inputs (source on the right) and leaves through outputs.
  return (
    <div className={`aadl-boundary ${s}${selected ? " selected" : ""}`} title={`${data.feature.name}: ${[data.feature.access, data.feature.direction, data.feature.featureKind].filter(Boolean).join(" ")}`}>
      {s === "out" || s === "inout" ? <Handle type="target" position={Position.Left} id={s === "inout" ? `${data.feature.name}~in` : data.feature.name} className="port-handle" /> : null}
      <Icon name={s === "in" ? "arrow-right" : s === "out" ? "arrow-left" : s === "access" ? "plug" : "arrow-swap"} />
      <span>{data.feature.name}</span>
      {s === "in" || s === "inout" || s === "access" ? <Handle type="source" position={Position.Right} id={s === "inout" ? `${data.feature.name}~out` : data.feature.name} className={`port-handle ${s === "access" ? "access" : ""}`} /> : null}
    </div>
  );
});

const nodeTypes = { component: ComponentNode, port: PortNode };

// ---- model → graph ------------------------------------------------------------------------------

function autoLayout(impl, subs, conns, ownFeatures) {
  const layer = new Map(subs.map((s) => [lc(s.name), 0]));
  for (let iter = 0; iter < subs.length; iter++) {
    let changed = false;
    for (const c of conns) {
      if (!c.src.context || !c.dst.context || lc(c.src.context) === lc(c.dst.context)) continue;
      const want = (layer.get(lc(c.src.context)) ?? 0) + 1;
      if (layer.has(lc(c.dst.context)) && want > layer.get(lc(c.dst.context)) && want < subs.length) {
        layer.set(lc(c.dst.context), want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const pos = {};
  const rowY = new Map();
  for (const s of subs) {
    const l = layer.get(lc(s.name));
    const y = rowY.get(l) || 0;
    pos[`sub:${lc(s.name)}`] = { x: 200 + l * COL_W, y };
    const ports = s._classifier ? s._features.length : 1;
    rowY.set(l, y + HEAD + Math.max(1, Math.ceil(ports / 2)) * PORT_ROW + 60 + ROW_GAP);
  }
  const maxLayer = Math.max(0, ...layer.values());
  let li = 0, ri = 0;
  for (const f of ownFeatures) {
    const s = side(f);
    if (s === "out") pos[`port:${lc(f.name)}`] = { x: 200 + (maxLayer + 1) * COL_W, y: ri++ * 56 };
    else pos[`port:${lc(f.name)}`] = { x: 0, y: li++ * 56 };
  }
  return pos;
}

function buildGraph(model, impl, layout, diagnostics) {
  const subs = model.allSubcomponents(impl).map((s) => ({ ...s, _features: s._classifier ? model.allFeatures(s._classifier) : [] }));
  const conns = model.allConnections(impl);
  const own = model.allFeatures(impl);
  const auto = autoLayout(impl, subs, conns, own);
  const nodes = [];
  for (const s of subs) {
    const id = `sub:${lc(s.name)}`;
    const subImpl = s._classifier?.kind === "componentImpl" ? s._classifier : null;
    const problem = diagnostics.some((d) => d.severity === "error" && d.line === s.loc.line && d.file === s.loc.file);
    nodes.push({
      id, type: "component", position: layout[id] || auto[id],
      data: {
        name: s.name, category: s.category, classifier: s.classifier?.name, features: s._features, decl: s,
        hasImpl: !!subImpl && model.allSubcomponents(subImpl).length > 0, implQName: subImpl ? `${subImpl.pkg}::${subImpl.name}` : null,
        calls: subImpl ? model.allCallSequences(subImpl) : [], problem, title: `${s.name}: ${s.category} ${s.classifier?.name || ""}`,
      },
    });
  }
  for (const f of own) {
    const id = `port:${lc(f.name)}`;
    nodes.push({ id, type: "port", position: layout[id] || auto[id], data: { feature: f } });
  }
  const handleFor = (end, role) => {
    const isOwn = !end.context;
    const f = isOwn ? own.find((x) => lc(x.name) === lc(end.feature)) : subs.find((s) => lc(s.name) === lc(end.context))?._features.find((x) => lc(x.name) === lc(end.feature));
    if (!f && isOwn) {
      // Access connections may name a bus / memory / data subcomponent itself: `bus access can -> imu.can`.
      const sub = subs.find((s) => lc(s.name) === lc(end.feature));
      if (sub) return { node: `sub:${lc(sub.name)}`, handle: SELF, feature: { featureKind: `${sub.category} access` } };
    }
    if (!f) return null;
    const s = side(f);
    let handle = f.name;
    if (s === "inout") handle = role === "source" ? `${f.name}~out` : `${f.name}~in`;
    return { node: isOwn ? `port:${lc(f.name)}` : `sub:${lc(end.context)}`, handle, feature: f };
  };
  const edges = [];
  for (const c of conns) {
    const a = handleFor(c.src, "source");
    const b = handleFor(c.dst, "target");
    if (!a || !b) continue;
    const isAccess = /access/.test(c.connectionKind);
    // For access connections React Flow needs a source handle on each end; both access handles are sources.
    edges.push({
      id: `conn:${lc(c.name)}`,
      source: a.node, sourceHandle: a.handle,
      target: b.node, targetHandle: b.handle,
      label: c.name,
      data: { decl: c },
      type: isAccess ? "straight" : "smoothstep",
      className: isAccess ? "aadl-edge access" : /event/.test(a.feature.featureKind || "") ? "aadl-edge event" : "aadl-edge",
      markerEnd: isAccess || c.bidirectional ? undefined : { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    });
  }
  return { nodes, edges, subs, own, conns };
}

// ---- canvas ---------------------------------------------------------------------------------------

function Canvas({ model, qname, getText, onEditFile, onOpenImpl, onNavigate, onRename, diagnostics, colorMode = "dark" }) {
  const impl = model.findByQualifiedName(qname);
  const pkg = impl ? model.findPackage(impl.pkg) : null;
  const flow = useReactFlow();
  const wrapper = useRef(null);
  const [layout, setLayout] = useState(() => loadLayout(qname));
  const [selection, setSelection] = useState({ nodes: [], edges: [] });
  const [paletteFilter, setPaletteFilter] = useState("");
  useEffect(() => setLayout(loadLayout(qname)), [qname]);

  const graph = useMemo(() => (impl ? buildGraph(model, impl, layout, diagnostics) : null), [model, impl, layout, diagnostics]);
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  useEffect(() => {
    if (!graph) return;
    // Keep React Flow's selection/measurement state across model updates.
    setNodes((prev) => graph.nodes.map((n) => {
      const old = prev.find((p) => p.id === n.id);
      return old ? { ...old, ...n, position: layout[n.id] || old.position || n.position, selected: old.selected } : n;
    }));
    setEdges((prev) => graph.edges.map((e) => ({ ...e, selected: prev.find((p) => p.id === e.id)?.selected })));
  }, [graph]);

  // Palette: classifiers that can become subcomponents.
  const palette = useMemo(() => {
    const out = [];
    if (!impl) return out;
    for (const p of model.packages.values()) {
      for (const c of p.classifiers) {
        if (c.category === "data" && p.name === "Base_Types") continue;
        if (c.visibility === "private" && p !== pkg) continue;
        if (c === impl) continue;
        out.push({ c, label: p === pkg ? c.name : `${p.name}::${c.name}` });
      }
    }
    return out.sort((a, b) => (a.c.pkg === impl.pkg ? 0 : 1) - (b.c.pkg === impl.pkg ? 0 : 1) || a.label.localeCompare(b.label));
  }, [model, pkg, impl]);

  // React Flow requires a stable selection handler (an inline one re-triggers itself every render).
  const onSelectionChange = useCallback(({ nodes: ns, edges: es }) => setSelection({ nodes: ns, edges: es }), []);

  const edit = useCallback((fn) => {
    const file = pkg.file;
    const text = getText(file);
    const next = fn(text);
    if (next !== text) onEditFile(file, next);
  }, [pkg, getText, onEditFile]);

  if (!impl || !graph) {
    return <div className="diagram-empty"><Icon name="warning" /> Implementation {qname} is not in the model (check the Problems view).</div>;
  }

  const endOf = (nodeId, handle) => {
    const feature = (handle || "").replace(/~(in|out)$/, "");
    if (nodeId.startsWith("port:")) return { context: null, feature: graph.own.find((f) => lc(f.name) === nodeId.slice(5))?.name || feature };
    const sub = graph.subs.find((s) => `sub:${lc(s.name)}` === nodeId);
    if (handle === SELF) return { context: null, feature: sub.name, self: sub };
    return { context: sub?.name, feature: sub?._features.find((f) => lc(f.name) === lc(feature))?.name || feature };
  };
  const featureOf = (end) => {
    if (end.self) return { featureKind: `${end.self.category} access`, access: "provides" };
    return (end.context ? graph.subs.find((s) => s.name === end.context)?._features : graph.own).find((f) => lc(f.name) === lc(end.feature));
  };

  const onConnect = ({ source, sourceHandle, target, targetHandle }) => {
    let src = endOf(source, sourceHandle);
    let dst = endOf(target, targetHandle);
    const fa = featureOf(src), fb = featureOf(dst);
    if (!fa || !fb) return;
    // Orient data flow: a subcomponent's input or the implementation's output is a destination.
    const isDestination = (end, f) => (end.context ? f.direction === "in" : f.direction === "out");
    if (isDestination(src, fa) && !isDestination(dst, fb)) [src, dst] = [dst, src];
    const kind = connectionKind(fa, fb);
    const taken = new Set(graph.conns.map((c) => lc(c.name)));
    let n = graph.conns.length + 1;
    while (taken.has(`c${n}`)) n++;
    const name = `c${n}`;
    // Access connections are written from the shared resource to the requiring feature.
    if (dst.self) [src, dst] = [dst, src];
    edit((text) => addConnection(text, impl, { name, kind, src: { context: src.context, feature: src.feature }, dst: { context: dst.context, feature: dst.feature } }));
  };

  const deleteSelection = (nodesToDelete, edgesToDelete) => {
    const members = [];
    for (const e of edgesToDelete) if (e.data?.decl) members.push(e.data.decl);
    for (const n of nodesToDelete) {
      if (n.type !== "component") continue;
      const s = n.data.decl;
      members.push(s, ...graph.conns.filter((c) => lc(c.src.context) === lc(s.name) || lc(c.dst.context) === lc(s.name)));
    }
    const unique = [...new Set(members)].filter((m) => m.loc.file === pkg.file);
    if (unique.length) edit((text) => removeMembers(text, unique));
  };

  const persist = (next) => {
    setLayout(next);
    saveLayout(qname, next);
  };

  const onNodesChange = (changes) => {
    // Removal goes through the AADL text (onNodesDelete); everything else is view state.
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), ns));

  };

  const onNodeDragStop = (_e, _node, dragged) => {
    persist({ ...layout, ...Object.fromEntries(dragged.map((n) => [n.id, n.position])) });
  };

  const addFromPalette = (c, position) => {
    const base = lc(c.name.split(".")[0]).replace(/[^a-z0-9_]/g, "_");
    const name = prompt(`Name of the new ${c.category} subcomponent:`, uniqueName(graph.subs.map((s) => s.name), base));
    if (!name || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return;
    if (position) persist({ ...layout, [`sub:${lc(name)}`]: position });
    edit((text) => addSubcomponent(text, pkg, impl, { name, classifier: c }));
  };

  const onDrop = (e) => {
    e.preventDefault();
    const label = e.dataTransfer.getData("application/x-aadl-classifier");
    const entry = palette.find((p) => p.label === label);
    if (!entry) return;
    addFromPalette(entry.c, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const selectedSub = selection.nodes.find((n) => n.type === "component");
  // Development aid for inspecting and driving the canvas from the console / browser tests.
  if (import.meta.env.DEV) window.__wosateDiagram = { nodes, edges, graph, flow, onConnect, deleteSelection, addFromPalette, palette };
  const shown = palette.filter((p) => !paletteFilter || p.label.toLowerCase().includes(paletteFilter.toLowerCase()));

  return (
    <div className="diagram">
      <div className="diagram-toolbar">
        <span className="title"><Icon name="type-hierarchy" />{impl.category} implementation <strong>{impl.pkg}::{impl.name}</strong></span>
        <span className="spacer" />
        {selectedSub ? (
          <>
            <button type="button" className="icon-btn" title="Rename subcomponent (updates every reference)" onClick={() => onRename(selectedSub.data.decl)}><Icon name="edit" /></button>
            <button type="button" className="icon-btn" title="Go to declaration" onClick={() => onNavigate(selectedSub.data.decl.loc)}><Icon name="go-to-file" /></button>
          </>
        ) : null}
        {selection.nodes.length || selection.edges.length ? (
          <button type="button" className="icon-btn" title="Delete selection (Del)" onClick={() => deleteSelection(selection.nodes, selection.edges)}><Icon name="trash" /></button>
        ) : null}
        <button type="button" className="icon-btn" title="Auto layout" onClick={() => { persist({}); setTimeout(() => flow.fitView({ padding: 0.2 }), 50); }}><Icon name="layout" /></button>
        <button type="button" className="icon-btn" title="Fit to view" onClick={() => flow.fitView({ padding: 0.2 })}><Icon name="screen-full" /></button>
        <button type="button" className="icon-btn" title="Show the AADL source" onClick={() => onNavigate(impl.loc)}><Icon name="file-code" /></button>
      </div>
      <div className="diagram-body">
        <div className="diagram-palette">
          <div className="palette-title">Palette — drag onto the canvas</div>
          <input type="text" placeholder="Filter classifiers" value={paletteFilter} onChange={(e) => setPaletteFilter(e.target.value)} aria-label="Filter classifiers" />
          <ul>
            {shown.map(({ c, label }) => (
              <li
                key={label}
                draggable
                title={`${c.category}${c.kind === "componentImpl" ? " implementation" : ""} ${label} — drag onto the canvas or double-click to add`}
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-aadl-classifier", label);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => addFromPalette(c, null)}
              >
                <Icon name={CATEGORY_ICON[c.category] || "symbol-misc"} />
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="diagram-flow" ref={wrapper} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; }} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onEdgesChange={(changes) => setEdges((es) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), es))}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onNodeDragStop={onNodeDragStop}
            onConnect={onConnect}
            onNodesDelete={(ns) => deleteSelection(ns, [])}
            onEdgesDelete={(es) => deleteSelection([], es)}
            onSelectionChange={onSelectionChange}
            onNodeDoubleClick={(_e, n) => (n.data.implQName && n.data.hasImpl ? onOpenImpl(n.data.implQName) : onNavigate(n.data.decl?.loc || n.data.feature?.loc))}
            onEdgeDoubleClick={(_e, edge) => onNavigate(edge.data.decl.loc)}
            connectionMode={ConnectionMode.Loose}
            deleteKeyCode={["Delete", "Backspace"]}
            colorMode={colorMode}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            minZoom={0.2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="aadl-minimap" />
          </ReactFlow>
        </div>
      </div>
    </div>
  );
}

export default function DiagramCanvas(props) {
  return (
    <ReactFlowProvider>
      <Canvas key={props.qname} {...props} />
    </ReactFlowProvider>
  );
}
