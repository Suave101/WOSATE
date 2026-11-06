// Resource budget analyses over the instance model, after OSATE's weight,
// power, processor load, memory and bus load analyses:
//   SEI::GrossWeight / NetWeight / WeightLimit, SEI::PowerBudget / PowerCapacity,
//   SEI::MIPSBudget / MIPSCapacity, SEI::RAM|ROMBudget / RAM|ROMCapacity,
//   SEI::BandWidthBudget / BandWidthCapacity (or a rate computed from Data_Size and Period),
// following Actual_Processor_Binding, Actual_Memory_Binding and Actual_Connection_Binding.

import { instanceProperty, connectionProperty, referenceTargets, connectionBindingTargets } from "../core/instance.js";
import { toBase, formatBase } from "../core/properties.js";
import { physicalProcessor } from "./schedulability.js";

const pct = (used, cap) => (cap ? `${((used / cap) * 100).toFixed(1)}%` : "—");
const statusOf = (used, cap) => (!cap ? "warning" : used > cap + 1e-12 ? "error" : used > 0.8 * cap ? "warning" : "ok");

/** Components bound to `target` through a reference property (threads inherit their process's binding). */
function boundTo(model, root, target, prop) {
  // For a physical processor this includes everything on its virtual processors (partitions).
  return [...root.walk()].filter((inst) => {
    if (inst === target || inst.category === "virtual processor") return false;
    if (referenceTargets(model, inst, prop).includes(target)) return true;
    return prop === "Actual_Processor_Binding" && target.category === "processor" && physicalProcessor(model, inst) === target;
  });
}

function capacityTable({ title, columns, resources, unitKind, summaryWord }) {
  let worst = "ok";
  const rows = [];
  const notes = [];
  for (const r of resources) {
    const st = statusOf(r.used, r.capacity);
    if (st === "error" || (st === "warning" && worst === "ok")) worst = st;
    if (!r.capacity) notes.push(`${r.inst.qualifiedPath} has no capacity property`);
    rows.push({ cells: [r.inst.qualifiedPath, formatBase(r.capacity, unitKind), formatBase(r.used, unitKind), pct(r.used, r.capacity), r.users.length ? `${r.users.length} bound` : "nothing bound"], status: st, emphasis: true });
    for (const u of r.users) rows.push({ cells: [`  ${u.label}`, "", formatBase(u.value, unitKind), pct(u.value, r.capacity), u.source], indent: 1 });
  }
  return { worst, section: { title, table: { columns, rows }, notes, csv: true }, summary: resources.map((r) => `${r.inst.name} ${pct(r.used, r.capacity)}`).join(", ") || `no ${summaryWord}` };
}

function processorLoad(ctx) {
  const { model, instance } = ctx;
  // Virtual processors are reported only when they declare their own capacity.
  const processors = [...instance.walk()].filter((i) => i.category === "processor" || (i.category === "virtual processor" && instanceProperty(model, i, "SEI::MIPSCapacity")));
  if (!processors.length) return { status: "info", summary: "No processors in the instance model", sections: [] };
  const resources = processors.map((p) => {
    const capacity = toBase(instanceProperty(model, p, "SEI::MIPSCapacity"), "mips") ?? toBase(instanceProperty(model, p, "SEI::Processor_Speed"), "mips");
    const users = [];
    for (const inst of boundTo(model, instance, p, "Actual_Processor_Binding")) {
      const budget = toBase(instanceProperty(model, inst, "SEI::MIPSBudget"), "mips");
      // Only count leaves with a budget, or a component whose own budget covers its children.
      if (budget === null) continue;
      if (inst.parent && boundTo(model, instance, p, "Actual_Processor_Binding").includes(inst.parent) && toBase(instanceProperty(model, inst.parent, "SEI::MIPSBudget"), "mips") !== null) continue;
      users.push({ label: `${inst.qualifiedPath} (${inst.category})`, value: budget, source: "SEI::MIPSBudget" });
    }
    return { inst: p, capacity, users, used: users.reduce((s, u) => s + u.value, 0) };
  });
  const t = capacityTable({ title: "Processor load (MIPS)", columns: ["Processor / bound component", "Capacity", "Budget", "Load", "Detail"], resources, unitKind: "mips", summaryWord: "processors" });
  return { status: t.worst, summary: `Processor load: ${t.summary}`, sections: [t.section] };
}

function memoryBudget(ctx) {
  const { model, instance } = ctx;
  const sections = [];
  let worst = "ok";
  const summaries = [];
  for (const [kind, budgetProp, capProp] of [["RAM", "SEI::RAMBudget", "SEI::RAMCapacity"], ["ROM", "SEI::ROMBudget", "SEI::ROMCapacity"]]) {
    const stores = [...instance.walk()].filter((i) => (i.category === "memory" || i.category === "processor") && instanceProperty(model, i, capProp));
    const resources = stores.map((m) => {
      const prop = m.category === "memory" ? "Actual_Memory_Binding" : "Actual_Processor_Binding";
      const users = [];
      for (const inst of boundTo(model, instance, m, prop)) {
        const actual = toBase(instanceProperty(model, inst, kind === "RAM" ? "SEI::RAMActual" : "SEI::ROMActual"), "size");
        const budget = toBase(instanceProperty(model, inst, budgetProp), "size");
        const value = actual ?? budget;
        if (value === null) continue;
        users.push({ label: `${inst.qualifiedPath} (${inst.category})`, value, source: actual !== null ? `${kind}Actual` : `${kind}Budget` });
      }
      return { inst: m, capacity: toBase(instanceProperty(model, m, capProp), "size"), users, used: users.reduce((s, u) => s + u.value, 0) };
    });
    if (!resources.length) continue;
    const t = capacityTable({ title: `${kind} usage`, columns: ["Memory / bound component", "Capacity", "Used", "Usage", "Source"], resources, unitKind: "size", summaryWord: kind });
    sections.push(t.section);
    summaries.push(`${kind}: ${t.summary}`);
    if (t.worst === "error" || (t.worst === "warning" && worst === "ok")) worst = t.worst;
  }
  if (!sections.length) return { status: "info", summary: "No memory or processor declares SEI::RAMCapacity / ROMCapacity", sections: [] };
  return { status: worst, summary: summaries.join(" · "), sections };
}

/** Bandwidth a connection needs: explicit budget/rate, or Data_Size × dispatch rate of the sender. */
function connectionRate(model, owner, conn) {
  for (const name of ["SEI::BandWidthBudget", "SEI::Data_Rate", "Communication_Properties::Data_Rate"]) {
    const v = toBase(connectionProperty(model, owner, conn, name), "dataRate");
    if (v !== null) return { value: v, source: name.replace(/^.*::/, "") };
  }
  const feature = conn.src.feature?.decl;
  const dataType = feature?._classifier;
  const size = dataType ? toBase(model.classifierProperties(dataType).filter((p) => /(^|::)data_size$/i.test(p.name)).at(-1)?.value, "size") : null;
  const period = senderPeriod(model, conn.src.component, conn.src.feature?.name);
  if (size !== null && period) return { value: size / period, source: `Data_Size ${formatBase(size, "size")} / Period ${formatBase(period, "time")}` };
  return { value: null, source: "no rate (set SEI::BandWidthBudget, or Data_Size on the data type and Period on the sender)" };
}

/** Period of whatever produces data on comp.feature, looking inside composite senders. */
function senderPeriod(model, comp, feature, depth = 0) {
  if (!comp || depth > 8) return null;
  const own = toBase(instanceProperty(model, comp, "Period"), "time");
  if (own) return own;
  const inner = comp.connections.find((c) => c.dst.component === comp && c.dst.feature?.name === feature && c.src.component !== comp);
  return inner ? senderPeriod(model, inner.src.component, inner.src.feature?.name, depth + 1) : null;
}

function busLoad(ctx) {
  const { model, instance } = ctx;
  const buses = [...instance.walk()].filter((i) => i.category === "bus" || i.category === "virtual bus");
  if (!buses.length) return { status: "info", summary: "No buses in the instance model", sections: [] };
  const usage = new Map(buses.map((b) => [b, []]));
  for (const owner of instance.walk()) {
    for (const conn of owner.connections) {
      for (const b of connectionBindingTargets(model, owner, conn)) {
        if (!usage.has(b)) continue;
        const r = connectionRate(model, owner, conn);
        usage.get(b).push({ label: `${owner.parent ? owner.qualifiedPath + "." : ""}${conn.name} (${conn.src.name} → ${conn.dst.name})`, value: r.value ?? 0, source: r.source, unknown: r.value === null });
      }
    }
  }
  const resources = buses.map((b) => ({
    inst: b,
    capacity: toBase(instanceProperty(model, b, "SEI::BandWidthCapacity"), "dataRate") ?? toBase(instanceProperty(model, b, "Communication_Properties::Bandwidth_Capacity"), "dataRate"),
    users: usage.get(b),
    used: usage.get(b).reduce((s, u) => s + u.value, 0),
  }));
  const t = capacityTable({ title: "Bus load", columns: ["Bus / bound connection", "Capacity", "Load", "Usage", "Rate source"], resources, unitKind: "dataRate", summaryWord: "buses" });
  const unknown = resources.flatMap((r) => r.users.filter((u) => u.unknown));
  if (unknown.length) t.section.notes.push(`${unknown.length} bound connection(s) have no data rate and count as 0`);
  return { status: unknown.length && t.worst === "ok" ? "warning" : t.worst, summary: `Bus load: ${t.summary}`, sections: [t.section] };
}

function weight(ctx) {
  const { model, instance } = ctx;
  const rows = [];
  let worst = "ok";
  const visit = (inst, depth) => {
    const row = { cells: [], status: null };
    rows.push(row);
    const net = toBase(instanceProperty(model, inst, "SEI::NetWeight"), "mass");
    const declared = toBase(instanceProperty(model, inst, "SEI::GrossWeight"), "mass");
    const limit = toBase(instanceProperty(model, inst, "SEI::WeightLimit"), "mass");
    let childSum = 0;
    for (const c of inst.children) childSum += visit(c, depth + 1);
    const computed = (net || 0) + childSum;
    // A declared gross weight wins for leaves; for composites the computed sum is checked against it.
    const gross = inst.children.length && computed > 0 ? computed : declared ?? computed;
    let status = null;
    const notes = [];
    if (declared !== null && inst.children.length && computed > 0 && computed > declared + 1e-12) {
      status = "warning";
      notes.push(`parts sum to ${formatBase(computed, "mass")}, more than declared ${formatBase(declared, "mass")}`);
    }
    if (limit !== null) {
      if (gross > limit + 1e-12) {
        status = "error";
        notes.push(`exceeds limit by ${formatBase(gross - limit, "mass")}`);
      } else {
        status ||= "ok";
        notes.push(`${((gross / limit) * 100).toFixed(1)}% of limit`);
      }
    }
    if (status === "error") worst = "error";
    else if (status === "warning" && worst === "ok") worst = "warning";
    row.cells = [`${"  ".repeat(depth)}${inst.parent ? inst.name : inst.name}`, inst.category, formatBase(net, "mass"), formatBase(gross, "mass"), formatBase(limit, "mass"), notes.join("; ")];
    row.status = status;
    row.indent = depth;
    return gross;
  };
  const total = visit(instance, 0);
  return {
    status: worst,
    summary: `Weight: ${instance.name} gross weight ${formatBase(total, "mass")}`,
    sections: [{ title: "Weight totals", table: { columns: ["Component", "Category", "Net", "Gross", "Limit", "Result"], rows } }],
  };
}

function power(ctx) {
  const { model, instance } = ctx;
  const consumers = [];
  const suppliers = [];
  for (const inst of instance.walk()) {
    const budget = toBase(instanceProperty(model, inst, "SEI::PowerBudget"), "power");
    const capacity = toBase(instanceProperty(model, inst, "SEI::PowerCapacity"), "power");
    if (budget !== null) consumers.push({ inst, budget });
    if (capacity !== null) suppliers.push({ inst, capacity });
  }
  const demand = consumers.reduce((s, c) => s + c.budget, 0);
  const supply = suppliers.reduce((s, c) => s + c.capacity, 0);
  let status = "ok";
  let verdict;
  if (!suppliers.length) {
    status = consumers.length ? "warning" : "info";
    verdict = "No component declares SEI::PowerCapacity";
  } else if (demand > supply + 1e-12) {
    status = "error";
    verdict = `Demand ${formatBase(demand, "power")} exceeds capacity ${formatBase(supply, "power")}`;
  } else {
    verdict = `Demand ${formatBase(demand, "power")} is ${((demand / supply) * 100).toFixed(1)}% of capacity ${formatBase(supply, "power")}`;
  }
  return {
    status,
    summary: `Power: ${verdict}`,
    sections: [
      { title: "Consumers (SEI::PowerBudget)", table: { columns: ["Component", "Category", "Budget"], rows: consumers.map((c) => ({ cells: [c.inst.qualifiedPath, c.inst.category, formatBase(c.budget, "power")] })) } },
      { title: "Suppliers (SEI::PowerCapacity)", table: { columns: ["Component", "Category", "Capacity"], rows: suppliers.map((c) => ({ cells: [c.inst.qualifiedPath, c.inst.category, formatBase(c.capacity, "power")] })) } },
    ],
  };
}

export default {
  id: "resource-budgets",
  name: "Resource Budgets",
  version: "0.1.0",
  description: "Weight, power, processor load (MIPS), RAM/ROM and bus bandwidth budgets using the SEI property set and deployment bindings.",
  analyses: [
    { id: "weight", label: "Weight Analysis", description: "Roll up SEI::NetWeight / GrossWeight and check SEI::WeightLimit.", scope: "instance", run: weight },
    { id: "power", label: "Power Budget Analysis", description: "Compare total SEI::PowerBudget with SEI::PowerCapacity.", scope: "instance", run: power },
    { id: "processor-load", label: "Processor Load (MIPS)", description: "SEI::MIPSBudget of bound components against each processor's SEI::MIPSCapacity.", scope: "instance", run: processorLoad },
    { id: "memory", label: "Memory Budget (RAM / ROM)", description: "RAM and ROM budgets of bound components against memory capacity.", scope: "instance", run: memoryBudget },
    { id: "bus-load", label: "Bus Load (Bandwidth)", description: "Bandwidth of connections bound to each bus against its capacity.", scope: "instance", run: busLoad },
  ],
};
