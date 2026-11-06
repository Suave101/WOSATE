// Shared helpers for the code generators: data type mapping, thread
// collection and semantic (thread-to-thread) connections.

import { instanceProperty, referenceTargets } from "../../core/instance.js";
import { toBase, rangeToBase } from "../../core/properties.js";
import { findProperty } from "../../core/model.js";

const lc = (s) => (s || "").toLowerCase();

export const ident = (s) => String(s).replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");

/** Data_Size in bytes of a data classifier, if declared. */
export function dataSize(model, c) {
  if (!c) return null;
  for (const k of model.extendsChain(c)) {
    const pa = model.classifierProperties(k).filter((p) => /(^|::)(data_size|source_data_size)$/i.test(p.name) && !p.appliesTo.length).at(-1);
    const v = pa && toBase(pa.value, "size");
    if (v) return v;
  }
  return null;
}

const BASE_C = {
  boolean: "bool", integer: "int32_t", integer_8: "int8_t", integer_16: "int16_t", integer_32: "int32_t", integer_64: "int64_t",
  unsigned_8: "uint8_t", unsigned_16: "uint16_t", unsigned_32: "uint32_t", unsigned_64: "uint64_t", natural: "uint32_t",
  float: "double", float_32: "float", float_64: "double", character: "char", string: "char*",
};
const BASE_ADA = {
  boolean: "Boolean", integer: "Integer", integer_8: "Interfaces.Integer_8", integer_16: "Interfaces.Integer_16",
  integer_32: "Interfaces.Integer_32", integer_64: "Interfaces.Integer_64", unsigned_8: "Interfaces.Unsigned_8",
  unsigned_16: "Interfaces.Unsigned_16", unsigned_32: "Interfaces.Unsigned_32", unsigned_64: "Interfaces.Unsigned_64",
  natural: "Natural", float: "Long_Float", float_32: "Float", float_64: "Long_Float", character: "Character", string: "String (1 .. 256)",
};

function representation(model, c) {
  for (const k of model.extendsChain(c)) {
    const rep = findProperty(k.properties, "Data_Model::Data_Representation");
    if (rep?.value?.type === "name") return lc(rep.value.name);
  }
  return null;
}

/** Collect every data classifier used by features of the instance, with dependencies first. */
export function dataTypes(model, root) {
  const seen = new Map();
  const visit = (c) => {
    if (!c || seen.has(c) || c.category !== "data") return;
    if (lc(c.pkg) === "base_types") return;
    // Struct implementations: fields are data subcomponents.
    if (c.kind === "componentImpl") for (const s of model.allSubcomponents(c)) visit(s._classifier);
    seen.set(c, true);
  };
  for (const inst of root.walk()) for (const f of inst.features) visit(f.decl._classifier);
  return [...seen.keys()];
}

export function cType(model, c) {
  if (!c) return "uint8_t";
  if (lc(c.pkg) === "base_types") return BASE_C[lc(c.name)] || "int32_t";
  for (const k of model.extendsChain(c)) if (lc(k.pkg) === "base_types") return BASE_C[lc(k.name)] || "int32_t";
  return ident(`${c.pkg}_${c.name}`);
}

export function adaType(model, c) {
  if (!c) return "Interfaces.Unsigned_8";
  if (lc(c.pkg) === "base_types") return BASE_ADA[lc(c.name)] || "Integer";
  for (const k of model.extendsChain(c)) if (lc(k.pkg) === "base_types") return BASE_ADA[lc(k.name)] || "Integer";
  return ident(`${c.name}`) + "_T";
}

/** C declaration of a data classifier (struct of subcomponents, enum, or sized opaque buffer). */
export function cTypedef(model, c) {
  const name = cType(model, c);
  const rep = representation(model, c);
  const fields = c.kind === "componentImpl" ? model.allSubcomponents(c) : [];
  if (fields.length) {
    return `typedef struct {\n${fields.map((f) => `  ${cType(model, f._classifier)} ${ident(f.name)};`).join("\n")}\n} ${name};`;
  }
  if (rep === "enum") {
    const pa = model.classifierProperties(c).filter((p) => /enumerators$/i.test(p.name)).at(-1);
    const lits = pa?.value?.type === "list" ? pa.value.items.map((i) => i.value) : ["VALUE"];
    return `typedef enum {\n${lits.map((l) => `  ${ident(`${name}_${l}`).toUpperCase()}`).join(",\n")}\n} ${name};`;
  }
  const size = dataSize(model, c);
  if (rep === "integer") return `typedef int32_t ${name};`;
  if (rep === "float") return `typedef double ${name};`;
  if (rep === "boolean") return `typedef bool ${name};`;
  return `typedef struct { uint8_t bytes[${size ? Math.ceil(size) : 1}]; } ${name}; /* ${size ? `Data_Size ${size} bytes` : "no Data_Size: placeholder"} */`;
}

export function adaTypedef(model, c) {
  const name = adaType(model, c);
  const fields = c.kind === "componentImpl" ? model.allSubcomponents(c) : [];
  if (fields.length) return `   type ${name} is record\n${fields.map((f) => `      ${ident(f.name)} : ${adaType(model, f._classifier)};`).join("\n")}\n   end record;`;
  const rep = representation(model, c);
  if (rep === "integer") return `   type ${name} is new Integer;`;
  if (rep === "float") return `   type ${name} is new Long_Float;`;
  if (rep === "boolean") return `   type ${name} is new Boolean;`;
  const size = dataSize(model, c);
  return `   type ${name} is array (1 .. ${size ? Math.ceil(size) : 1}) of Interfaces.Unsigned_8;`;
}

/** Threads in the instance with their timing. */
export function threads(model, root) {
  const out = [];
  for (const inst of root.walk()) {
    if (inst.category !== "thread") continue;
    const dp = instanceProperty(model, inst, "Dispatch_Protocol");
    const period = toBase(instanceProperty(model, inst, "Period"), "time");
    const wcet = rangeToBase(instanceProperty(model, inst, "Compute_Execution_Time"), "time");
    const entry = instanceProperty(model, inst, "Compute_Entrypoint_Source_Text");
    const prio = instanceProperty(model, inst, "Priority");
    out.push({
      inst,
      id: ident(inst.qualifiedPath.replace(/\./g, "_")),
      protocol: dp?.type === "name" ? lc(dp.name) : "periodic",
      period,
      wcet,
      entry: entry?.type === "string" ? ident(entry.value) : `${ident(inst.qualifiedPath.replace(/\./g, "_"))}_step`,
      priority: prio?.type === "number" ? prio.value : null,
      processor: referenceTargets(model, inst, "Actual_Processor_Binding")[0] || null,
    });
  }
  // Rate-monotonic priorities where none are given (higher number = higher priority).
  const byPeriod = [...out].filter((t) => t.priority === null).sort((a, b) => (b.period ?? 1e9) - (a.period ?? 1e9));
  byPeriod.forEach((t, i) => (t.priority = 10 + i));
  return out;
}

/**
 * Semantic connections: end-to-end thread/device-level port connections obtained by following
 * declared connections up through and down into enclosing components.
 */
export function semanticConnections(root) {
  const out = [];
  const isLeaf = (c) => !c.children.length || !["system", "process", "thread group", "abstract"].includes(c.category);
  const descend = (comp, feature, path, visit) => {
    const inner = comp.connections.filter((c) => c.src.component === comp && lc(c.src.feature?.name) === lc(feature) && c.dst.component !== comp);
    if (!inner.length || isLeaf(comp)) return visit(comp, feature, path);
    for (const c of inner) descend(c.dst.component, c.dst.feature?.name, [...path, c], visit);
  };
  const ascend = (comp, feature, path, visit) => {
    const parent = comp.parent;
    if (!parent) return;
    for (const c of parent.connections) {
      if (c.src.component !== comp || lc(c.src.feature?.name) !== lc(feature)) continue;
      if (c.dst.component === parent) ascend(parent, c.dst.feature.name, [...path, c], visit);
      else if (c.dst.component) descend(c.dst.component, c.dst.feature?.name, [...path, c], visit);
    }
  };
  for (const inst of root.walk()) {
    if (!isLeaf(inst)) continue;
    for (const f of inst.features) {
      if (!/port/.test(f.kind || "") || !/out/.test(f.direction || "")) continue;
      ascend(inst, f.name, [], (dst, dstFeature, path) => {
        if (dst === inst) return;
        out.push({ src: inst, srcFeature: f, dst, dstFeature: dst.features.find((x) => lc(x.name) === lc(dstFeature)), path });
      });
    }
  }
  return out;
}
