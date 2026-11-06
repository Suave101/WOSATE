// Schedulability analysis in the style of Cheddar: per processor, the
// periodic and sporadic threads bound to it (directly, through their process,
// or through a virtual processor / ARINC 653 partition) are checked with the
// Liu & Layland utilization bound, exact response-time analysis for
// fixed-priority scheduling (RM / DM / explicit Priority) and the EDF
// utilization test.

import { instanceProperty, referenceTargets } from "../core/instance.js";
import { toBase, rangeToBase, formatBase } from "../core/properties.js";
import { FLIGHT_COMPUTER } from "./flight-computer.js";

const lc = (s) => (s || "").toLowerCase();

/** The physical processor a component ends up on (following virtual processor bindings). */
export function physicalProcessor(model, inst) {
  let targets = referenceTargets(model, inst, "Actual_Processor_Binding");
  for (let guard = 0; guard < 8 && targets.length; guard++) {
    const t = targets[0];
    if (t.category === "processor") return t;
    targets = referenceTargets(model, t, "Actual_Processor_Binding");
    if (!targets.length && t.parent?.category === "processor") return t.parent;
  }
  return null;
}

export function taskSet(model, root, processor) {
  const tasks = [];
  for (const inst of root.walk()) {
    if (inst.category !== "thread" || physicalProcessor(model, inst) !== processor) continue;
    const dispatch = instanceProperty(model, inst, "Dispatch_Protocol");
    const protocol = dispatch?.type === "name" ? lc(dispatch.name) : "periodic";
    if (!["periodic", "sporadic", "timed", "hybrid"].includes(protocol)) continue;
    const T = toBase(instanceProperty(model, inst, "Period"), "time");
    const cet = rangeToBase(instanceProperty(model, inst, "Compute_Execution_Time"), "time");
    const D = toBase(instanceProperty(model, inst, "Deadline"), "time") ?? T;
    const prio = instanceProperty(model, inst, "Priority");
    tasks.push({ inst, name: inst.qualifiedPath, protocol, T, C: cet ? cet[1] : null, D, priority: prio?.type === "number" ? prio.value : null });
  }
  return tasks;
}

export function responseTimes(tasks, order) {
  const sorted = [...tasks].sort(order);
  return sorted.map((t, i) => {
    const hp = sorted.slice(0, i);
    let R = t.C;
    for (let iter = 0; iter < 1000; iter++) {
      const next = t.C + hp.reduce((s, j) => s + Math.ceil(R / j.T - 1e-12) * j.C, 0);
      if (Math.abs(next - R) < 1e-12) break;
      R = next;
      if (R > t.D * 10) break;
    }
    return { ...t, R, rank: i + 1, ok: R <= t.D + 1e-12 };
  });
}

function protocolOf(model, processor) {
  const v = instanceProperty(model, processor, "Scheduling_Protocol");
  const name = v?.type === "list" ? v.items[0]?.name : v?.name;
  const n = lc(name || "");
  if (n === "edf") return "EDF";
  if (n.includes("deadline") || n === "dms") return "DM";
  if (n.includes("posix") || n.includes("highest_priority")) return "FP";
  return "RM";
}

function run({ model, instance }) {
  const processors = [...instance.walk()].filter((i) => i.category === "processor");
  if (!processors.length) return { status: "info", summary: "No processors in the instance model", sections: [] };
  const sections = [];
  const csvRows = [];
  let worst = "ok";
  const summary = [];
  for (const p of processors) {
    const tasks = taskSet(model, instance, p);
    const missing = tasks.filter((t) => !t.T || t.C === null);
    const valid = tasks.filter((t) => t.T && t.C !== null);
    const protocol = protocolOf(model, p);
    const U = valid.reduce((s, t) => s + t.C / t.T, 0);
    const n = valid.length;
    const llBound = n ? n * (2 ** (1 / n) - 1) : 1;
    let rows = [], ok = true;
    const notes = [`Scheduling: ${protocol === "EDF" ? "earliest deadline first" : protocol === "DM" ? "deadline monotonic" : protocol === "FP" ? "fixed priority (Priority property)" : "rate monotonic"}; utilization U = ${(U * 100).toFixed(1)}%`];
    if (protocol === "EDF") {
      const density = valid.reduce((s, t) => s + t.C / Math.min(t.D, t.T), 0);
      ok = density <= 1 + 1e-12;
      notes.push(`EDF test: Σ C/min(D,T) = ${(density * 100).toFixed(1)}% ${ok ? "≤" : ">"} 100%`);
      rows = valid.map((t) => ({ cells: [t.name, t.protocol, formatBase(t.T, "time"), formatBase(t.C, "time"), formatBase(t.D, "time"), "—", `${((t.C / t.T) * 100).toFixed(1)}%`, "—", ok ? "yes" : "no"], status: ok ? "ok" : "error" }));
    } else {
      const order = protocol === "FP"
        ? (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
        : protocol === "DM" ? (a, b) => a.D - b.D : (a, b) => a.T - b.T;
      const rta = responseTimes(valid, order);
      ok = rta.every((t) => t.ok);
      notes.push(`Liu & Layland bound for ${n} task${n === 1 ? "" : "s"}: ${(llBound * 100).toFixed(1)}% (${U <= llBound ? "met — schedulable" : "exceeded — exact response-time analysis decides"})`);
      rows = rta.map((t) => ({ cells: [t.name, t.protocol, formatBase(t.T, "time"), formatBase(t.C, "time"), formatBase(t.D, "time"), String(t.rank), `${((t.C / t.T) * 100).toFixed(1)}%`, formatBase(t.R, "time"), t.ok ? "yes" : "no"], status: t.ok ? "ok" : "error" }));
    }
    for (const t of missing) {
      rows.push({ cells: [t.name, t.protocol, formatBase(t.T, "time"), formatBase(t.C, "time"), "", "", "", "", "missing Period / Compute_Execution_Time"], status: "warning" });
    }
    if (U > 1) ok = false;
    const status = !tasks.length ? "info" : !ok ? "error" : missing.length ? "warning" : "ok";
    if (status === "error" || (status === "warning" && worst === "ok")) worst = status;
    summary.push(`${p.name}: ${tasks.length ? `${(U * 100).toFixed(0)}% ${ok ? "schedulable" : "NOT schedulable"}` : "no threads"}`);
    sections.push({
      title: `${p.qualifiedPath} — ${n} thread${n === 1 ? "" : "s"}, U = ${(U * 100).toFixed(1)}%`,
      csv: true,
      table: { columns: ["Thread", "Dispatch", "Period", "WCET", "Deadline", "Priority rank", "Utilization", "Response time", "Meets deadline"], rows },
      notes,
    });
    for (const r of rows) csvRows.push([p.qualifiedPath, ...r.cells]);
  }
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  return {
    status: worst,
    summary: `Schedulability: ${summary.join(", ")}`,
    sections,
    files: [{ name: `${instance.name}_tasks.csv`, mime: "text/csv", text: [["Processor", "Thread", "Dispatch", "Period", "WCET", "Deadline", "Rank", "Utilization", "Response", "OK"].map(q).join(","), ...csvRows.map((r) => r.map(q).join(","))].join("\n") }],
  };
}

export default {
  id: "schedulability",
  name: "Schedulability",
  version: "0.1.0",
  description: "Cheddar-style processor schedulability: utilization bounds, response-time analysis (RM / DM / fixed priority) and EDF, over threads bound to each processor.",
  analyses: [{ id: "rta", label: "Schedulability Analysis", description: "Per-processor utilization and worst-case response times of bound threads.", scope: "instance", run }],
  examples: [FLIGHT_COMPUTER],
};
