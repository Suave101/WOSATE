// Instance model plug-in: OSATE's "Instantiate" output as a hierarchy table and
// a graphical block diagram of the selected implementation.

import { instanceProperty } from "../core/instance.js";
import { formatValue } from "../core/properties.js";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const isIn = (f) => f.direction === "in" || (!f.direction && f.decl.access === "requires");
const BOX_W = 170, PORT_H = 18, HEAD_H = 36, COL_GAP = 110, ROW_GAP = 28, MARGIN = 40;

/** Lay out the subcomponents of an instance in columns by connection depth and draw an SVG. */
export function diagramSvg(inst) {
  const children = inst.children;
  const edges = inst.connections.filter((c) => c.src.component && c.dst.component);
  const layer = new Map(children.map((c) => [c, 0]));
  for (let iter = 0; iter < children.length; iter++) {
    let changed = false;
    for (const e of edges) {
      if (e.src.component === inst || e.dst.component === inst || e.src.component === e.dst.component) continue;
      const want = layer.get(e.src.component) + 1;
      if (want > layer.get(e.dst.component) && want < children.length) {
        layer.set(e.dst.component, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const columns = [];
  for (const c of children) (columns[layer.get(c)] ||= []).push(c);

  const outerIns = inst.features.filter(isIn);
  const outerOuts = inst.features.filter((f) => !isIn(f));
  const pos = new Map();
  const portPos = new Map();
  const leftPad = MARGIN + (outerIns.length ? 70 : 10);
  let maxY = 0;
  columns.forEach((col, ci) => {
    let y = MARGIN + HEAD_H;
    for (const c of col || []) {
      const ins = c.features.filter(isIn);
      const outs = c.features.filter((f) => !isIn(f));
      const h = HEAD_H + Math.max(ins.length, outs.length, 1) * PORT_H + 10;
      const x = leftPad + ci * (BOX_W + COL_GAP);
      pos.set(c, { x, y, w: BOX_W, h, ins, outs });
      ins.forEach((f, i) => portPos.set(f, { x, y: y + HEAD_H + i * PORT_H + PORT_H / 2, side: "left" }));
      outs.forEach((f, i) => portPos.set(f, { x: x + BOX_W, y: y + HEAD_H + i * PORT_H + PORT_H / 2, side: "right" }));
      y += h + ROW_GAP;
    }
    maxY = Math.max(maxY, y);
  });
  const innerW = Math.max(1, columns.length) * (BOX_W + COL_GAP) - COL_GAP;
  const width = leftPad + innerW + (outerOuts.length ? 80 : 20) + MARGIN;
  const height = Math.max(maxY, MARGIN + HEAD_H + Math.max(outerIns.length, outerOuts.length) * 34 + 20) + MARGIN / 2;
  const frame = { x: MARGIN / 2, y: MARGIN / 2, w: width - MARGIN, h: height - MARGIN / 2 };
  const spread = (list, side) => list.forEach((f, i) => {
    portPos.set(f, { x: side === "left" ? frame.x : frame.x + frame.w, y: frame.y + HEAD_H + 20 + i * 34, side: side === "left" ? "outer-in" : "outer-out" });
  });
  spread(outerIns, "left");
  spread(outerOuts, "right");

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" class="aadl-diagram" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="Diagram of ${esc(inst.name)}">`);
  parts.push(`<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="d-arrow"/></marker></defs>`);
  parts.push(`<rect class="d-frame" x="${frame.x}" y="${frame.y}" width="${frame.w}" height="${frame.h}" rx="10"/>`);
  parts.push(`<text class="d-title" x="${frame.x + 12}" y="${frame.y + 22}">${esc(inst.implementation?.name || inst.classifier?.name || inst.name)}</text>`);
  for (const f of [...outerIns, ...outerOuts]) {
    const p = portPos.get(f);
    const left = p.side === "outer-in";
    parts.push(`<rect class="d-port" x="${p.x - 5}" y="${p.y - 5}" width="10" height="10"/>`);
    parts.push(`<text class="d-port-label" x="${left ? p.x + 10 : p.x - 10}" y="${p.y - 9}" text-anchor="${left ? "start" : "end"}">${esc(f.name)}</text>`);
  }
  for (const [c, b] of pos) {
    parts.push(`<g class="d-comp d-${esc(c.category.replace(/\s+/g, "-"))}">`);
    parts.push(`<rect class="d-box" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="${c.category === "process" ? 0 : 6}"/>`);
    parts.push(`<text class="d-name" x="${b.x + 10}" y="${b.y + 16}">${esc(c.name)}</text>`);
    parts.push(`<text class="d-class" x="${b.x + 10}" y="${b.y + 29}">${esc(c.category)}${c.classifier ? " " + esc(c.classifier.name) : ""}</text>`);
    for (const f of b.ins) {
      const p = portPos.get(f);
      parts.push(`<rect class="d-port" x="${p.x - 5}" y="${p.y - 5}" width="10" height="10"/><text class="d-port-label" x="${p.x + 9}" y="${p.y + 4}">${esc(f.name)}</text>`);
    }
    for (const f of b.outs) {
      const p = portPos.get(f);
      parts.push(`<rect class="d-port" x="${p.x - 5}" y="${p.y - 5}" width="10" height="10"/><text class="d-port-label" x="${p.x - 9}" y="${p.y + 4}" text-anchor="end">${esc(f.name)}</text>`);
    }
    parts.push(`</g>`);
  }
  for (const e of edges) {
    const a = e.src.feature && portPos.get(e.src.feature);
    const b = e.dst.feature && portPos.get(e.dst.feature);
    if (!a || !b) continue;
    const dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const c1 = a.side === "left" ? a.x - dx : a.x + dx;
    const c2 = b.side === "right" || b.side === "outer-out" ? b.x + (b.side === "outer-out" ? -dx : dx) : b.x - dx;
    const c1x = a.side === "outer-in" ? a.x + dx : c1;
    parts.push(`<path class="d-conn" d="M${a.x},${a.y} C${c1x},${a.y} ${c2},${b.y} ${b.x},${b.y}" marker-end="url(#arrow)"><title>${esc(e.name)}: ${esc(e.src.name)} → ${esc(e.dst.name)}</title></path>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

function hierarchyRows(model, inst, depth = 0, rows = []) {
  const props = [];
  for (const name of ["Period", "Dispatch_Protocol", "Compute_Execution_Time", "SEI::GrossWeight", "SEI::PowerBudget"]) {
    const v = instanceProperty(model, inst, name);
    if (v) props.push(`${name.replace(/^SEI::/, "")} = ${formatValue(v)}`);
  }
  rows.push({
    cells: [`${"  ".repeat(depth)}${inst.name}`, inst.category, inst.classifier ? `${inst.classifier.pkg}::${inst.classifier.name}` : "—", String(inst.features.length), props.join(", ")],
    indent: depth,
  });
  for (const c of inst.children) hierarchyRows(model, c, depth + 1, rows);
  return rows;
}

function instantiateAnalysis(ctx) {
  const { model, instance, instanceProblems = [] } = ctx;
  let comps = 0, conns = 0, flows = 0;
  for (const i of instance.walk()) {
    comps++;
    conns += i.connections.length;
    flows += i.flows.length;
  }
  const diagrams = [];
  for (const i of instance.walk()) {
    if (i.children.length) diagrams.push({ title: `Diagram: ${i.qualifiedPath} (${i.implementation?.name})`, svg: diagramSvg(i) });
  }
  return {
    status: instanceProblems.length ? "warning" : "ok",
    summary: `Instantiated ${instance.name}: ${comps} components, ${conns} connections, ${flows} flows`,
    sections: [
      ...diagrams.slice(0, 6),
      { title: "Instance hierarchy", table: { columns: ["Component", "Category", "Classifier", "Features", "Key properties"], rows: hierarchyRows(model, instance) }, notes: instanceProblems },
    ],
    files: [{ name: `${instance.name}.json`, mime: "application/json", text: JSON.stringify(serialize(instance), null, 2) }],
  };
}

function serialize(inst) {
  return {
    name: inst.name,
    category: inst.category,
    classifier: inst.classifier ? `${inst.classifier.pkg}::${inst.classifier.name}` : null,
    features: inst.features.map((f) => ({ name: f.name, direction: f.direction, kind: f.kind })),
    connections: inst.connections.map((c) => ({ name: c.name, source: c.src.name, destination: c.dst.name })),
    children: inst.children.map(serialize),
  };
}

export default {
  id: "instance-view",
  name: "Instance Model & Diagrams",
  version: "0.1.0",
  description: "Instantiate a system implementation, browse the component hierarchy, and view block diagrams.",
  analyses: [
    {
      id: "instantiate",
      label: "Instantiate & Diagram",
      description: "Build the instance model of the selected implementation.",
      scope: "instance",
      run: instantiateAnalysis,
    },
  ],
};
