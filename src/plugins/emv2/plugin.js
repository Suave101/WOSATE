// EMV2 plug-in: Error Model Annex v2 parsing and validation, fault
// propagation, FMEA, fault tree analysis (minimal cut sets, Open-PSA export)
// and hazard logs.

import { parseEmv2, EMV2_KEYWORDS } from "./parser.js";
import { ErrorModel, validateEmv2, errorSources, propagate, fmea, hazards, faultTree, toOpenPsa } from "./semantics.js";
import { ERROR_LIBRARY } from "./library.js";
import { EMV2_EXAMPLE } from "./example.js";

const pText = (p) => (p === null || p === undefined ? "—" : p.toExponential(2));
const csv = (columns, rows) => {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return [columns.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n");
};

function propagationAnalysis({ model, instance }) {
  const em = new ErrorModel(model);
  const sources = errorSources(em, instance);
  if (!sources.length) return { status: "info", summary: `No EMV2 error sources in ${instance.name}`, sections: [] };
  const sections = [];
  let unhandled = 0, count = 0;
  for (const src of sources) {
    const paths = propagate(em, model, instance, src.inst, src.point, src.types);
    count += paths.length;
    const rows = paths.map((path) => {
      const end = path.at(-1);
      const bad = ["unhandled", "undeclared", "unconnected"].includes(end.end);
      if (bad) unhandled++;
      return {
        status: bad ? "warning" : end.end === "sink" ? "ok" : "info",
        cells: [path.filter((s) => s.inst || s.kind).map((s) => s.text).join("  →  "), end.text],
      };
    });
    sections.push({
      title: `${src.inst.qualifiedPath}: ${src.name} (${src.cause}) → ${src.point} {${src.types.map((t) => em.shortName(t)).join(", ")}}`,
      table: { columns: ["Propagation path", "Outcome"], rows },
    });
  }
  return {
    status: unhandled ? "warning" : "ok",
    summary: `${sources.length} error source${sources.length > 1 ? "s" : ""}, ${count} propagation path${count === 1 ? "" : "s"}${unhandled ? `, ${unhandled} not handled` : ""}`,
    sections,
  };
}

const FMEA_COLUMNS = ["ID", "Component", "Failure mode", "Cause", "Local effect", "Next higher effect", "End effect", "Severity", "Likelihood", "Probability", "Detection"];

function fmeaAnalysis({ model, instance }) {
  const em = new ErrorModel(model);
  const rows = fmea(em, model, instance);
  if (!rows.length) return { status: "info", summary: `No EMV2 error sources in ${instance.name}`, sections: [] };
  const cells = rows.map((r) => [r.id, r.component, r.failureMode, r.cause, r.localEffect, r.nextEffect, r.endEffect, r.severity, r.likelihood, pText(r.probability), r.detection]);
  return {
    status: "ok",
    summary: `FMEA: ${rows.length} failure mode effect${rows.length > 1 ? "s" : ""} for ${instance.name}`,
    sections: [{
      title: "Failure Mode and Effects Analysis",
      csv: true,
      table: { columns: FMEA_COLUMNS, rows: cells.map((c, i) => ({ cells: c, status: ["unhandled", "undeclared"].includes(rows[i].endKind) ? "warning" : null })) },
    }],
    files: [{ name: `${instance.name}_FMEA.csv`, text: csv(FMEA_COLUMNS, cells), mime: "text/csv" }],
  };
}

function treeRows(node, depth = 0, rows = []) {
  const gate = node.kind === "basic" ? "basic event" : node.kind === "undeveloped" ? "undeveloped" : node.kind === "vote" ? `${node.k}-of-${node.children.length}` : node.kind.toUpperCase();
  rows.push({ cells: [`${"  ".repeat(depth)}${node.label}`, gate, node.kind === "basic" ? pText(node.p) : ""], indent: depth, status: node.kind === "undeveloped" ? "warning" : null });
  for (const c of node.children || []) treeRows(c, depth + 1, rows);
  return rows;
}

function ftaAnalysis({ model, instance }) {
  const em = new ErrorModel(model);
  const rootEm = em.forClassifier(instance.classifier);
  const tops = [];
  for (const r of rootEm?.composite || []) {
    if (!tops.some((t) => t.state === r.dst.state)) tops.push({ inst: instance, state: r.dst.state, label: `${instance.name} in ${r.dst.state}` });
  }
  if (!tops.length) {
    // No composite behavior: one tree per error type leaving the system.
    const seen = new Set();
    for (const src of errorSources(em, instance)) {
      for (const path of propagate(em, model, instance, src.inst, src.point, src.types)) {
        const exit = path.filter((s) => s.inst === instance).at(-1);
        if (path.at(-1).end !== "boundary" || !exit) continue;
        for (const t of exit.types) {
          const key = `${exit.point}|${t}`;
          if (seen.has(key)) continue;
          seen.add(key);
          tops.push({ inst: instance, point: exit.point, types: [t], label: `${instance.name}.${exit.point} {${em.shortName(t)}}` });
        }
      }
    }
  }
  if (!tops.length) return { status: "info", summary: `No top events: add a composite error behavior to ${instance.classifier.name} or propagations that leave the system`, sections: [] };
  const sections = [];
  const files = [];
  let undeveloped = 0;
  for (const top of tops) {
    const result = faultTree(em, model, instance, top);
    undeveloped += result.cuts.filter((c) => c.events.some((e) => e.undeveloped)).length;
    sections.push({ title: `Fault tree: ${top.label} — P(top) ≈ ${pText(result.probability)}`, table: { columns: ["Event / gate", "Type", "Probability"], rows: treeRows(result.tree) } });
    sections.push({
      title: `Minimal cut sets: ${top.label} (${result.cuts.length})`,
      csv: true,
      table: {
        columns: ["#", "Order", "Basic events", "Probability"],
        rows: result.cuts.map((c, i) => ({ cells: [String(i + 1), String(c.events.length), c.events.map((e) => e.label).join("  AND  "), pText(c.p)], status: c.events.some((e) => e.undeveloped) ? "warning" : null })),
      },
      notes: ["Top-event probability uses the minimal-cut-set upper bound 1 − Π(1 − P(cut set)), assuming independent basic events."],
    });
    const fname = top.label.replace(/[^\w]+/g, "_");
    files.push({ name: `${fname}.opsa.xml`, text: toOpenPsa(top.label, result), mime: "application/xml" });
    files.push({ name: `${fname}.fta.json`, text: JSON.stringify({ top: top.label, probability: result.probability, tree: result.tree, minimalCutSets: result.cuts.map((c) => ({ probability: c.p, events: c.events.map((e) => e.id) })) }, null, 2), mime: "application/json" });
  }
  return {
    status: undeveloped ? "warning" : "ok",
    summary: `Fault tree analysis: ${tops.length} top event${tops.length > 1 ? "s" : ""}${undeveloped ? `, ${undeveloped} cut set(s) contain undeveloped events` : ""}`,
    sections,
    files,
  };
}

const HAZARD_COLUMNS = ["ID", "Hazard", "Description", "Component", "Element", "Failure", "Effect", "Phases", "Severity", "Likelihood", "Risk"];

function hazardAnalysis({ model, instance }) {
  const em = new ErrorModel(model);
  const rows = hazards(em, instance);
  if (!rows.length) return { status: "info", summary: "No EMV2::Hazards properties in the instance model", sections: [] };
  const cells = rows.map((r) => [r.id, r.title, r.description, r.component, r.element, r.failure, r.effect, r.phases, r.severity, r.likelihood, r.risk]);
  return {
    status: "ok",
    summary: `Hazard log: ${rows.length} hazard${rows.length > 1 ? "s" : ""}`,
    sections: [{ title: "Hazard log", csv: true, table: { columns: HAZARD_COLUMNS, rows: cells.map((c) => ({ cells: c })) } }],
    files: [{ name: `${instance.name}_hazards.csv`, text: csv(HAZARD_COLUMNS, cells), mime: "text/csv" }],
  };
}

export default {
  id: "emv2",
  name: "Error Model (EMV2)",
  version: "0.1.0",
  description: "Error Model Annex v2: error types, propagations, error flows and behavior state machines, with fault propagation, FMEA, fault tree (Open-PSA) and hazard-log reports.",
  annexes: {
    emv2: { parse: (text, ctx) => parseEmv2(text, ctx) },
  },
  validate: validateEmv2,
  editorKeywords: EMV2_KEYWORDS,
  libraries: [{ name: "ErrorLibrary.aadl", text: ERROR_LIBRARY }],
  analyses: [
    { id: "propagation", label: "EMV2: Fault Propagation Paths", description: "Trace every error source through connections, error paths and bindings.", scope: "instance", run: propagationAnalysis },
    { id: "fmea", label: "EMV2: FMEA Table", description: "Failure Mode and Effects Analysis from error sources and propagation paths (CSV).", scope: "instance", run: fmeaAnalysis },
    { id: "fta", label: "EMV2: Fault Tree Analysis", description: "Fault trees from composite and component error behavior, minimal cut sets, Open-PSA XML.", scope: "instance", run: ftaAnalysis },
    { id: "hazards", label: "EMV2: Hazard Log", description: "Hazards declared with EMV2::Hazards (CSV).", scope: "instance", run: hazardAnalysis },
  ],
  examples: [EMV2_EXAMPLE],
};
