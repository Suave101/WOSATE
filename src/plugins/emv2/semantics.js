// EMV2 semantics over the declarative and instance models: error type
// resolution, merged component error models, legality checks, fault
// propagation, FMEA rows, fault trees (with minimal cut sets) and hazards.

import { propertyNameMatches } from "../../core/model.js";
import { instanceProperty } from "../../core/instance.js";
import { formatValue } from "../../core/properties.js";

const lc = (s) => (s || "").toLowerCase();
const SPECIAL_POINTS = new Set(["processor", "memory", "bindings", "binding", "connection", "access", "all"]);

export class ErrorModel {
  constructor(model) {
    this.model = model;
    this.types = new Map(); // "pkg::type" -> { name, pkg, parent, loc }
    this.typeSets = new Map();
    this.behaviors = new Map(); // "pkg::behavior" -> behavior
    this.libraries = new Map(); // pkg -> library AST
    this.cache = new Map();
    for (const { annex, pkg } of model.annexLibraries("emv2")) {
      const lib = annex.parsed;
      if (!lib || lib.kind !== "emv2Library") continue;
      this.libraries.set(lc(pkg.name), { lib, pkg });
      for (const t of lib.types) this.types.set(lc(`${pkg.name}::${t.name}`), { ...t, pkg: pkg.name });
      for (const s of lib.typeSets) this.typeSets.set(lc(`${pkg.name}::${s.name}`), { ...s, pkg: pkg.name });
      for (const b of lib.behaviors) this.behaviors.set(lc(`${pkg.name}::${b.name}`), { ...b, pkg: pkg.name });
    }
  }

  /** Resolve an error type or type set name against the `use types` libraries. */
  resolveType(name, useTypes = []) {
    const candidates = name.includes("::") ? [name] : [...useTypes, ...this.extendedLibraries(useTypes)].map((l) => `${l}::${name}`);
    for (const c of candidates) {
      const key = lc(c);
      const t = this.types.get(key);
      if (t?.renames) return this.resolveType(t.renames, [t.pkg]);
      if (t) return { kind: "type", key, name: t.name };
      if (this.typeSets.has(key)) return { kind: "set", key, name: this.typeSets.get(key).name };
    }
    return null;
  }

  extendedLibraries(useTypes) {
    return useTypes.flatMap((u) => this.libraries.get(lc(u))?.lib.extends || []);
  }

  /** Expand a type set (list of products) into concrete type keys. */
  expand(typeSet, useTypes) {
    const out = [];
    for (const el of typeSet || []) {
      if (el.types.length === 1 && lc(el.types[0]) === "noerror") continue;
      const r = this.resolveType(el.types[0], useTypes);
      if (!r) continue;
      if (r.kind === "set") {
        const set = this.typeSets.get(r.key);
        out.push(...this.expand(set.members, [set.pkg, ...useTypes]));
      } else out.push(r.key);
    }
    return [...new Set(out)];
  }

  isSubtype(key, ancestor) {
    let cur = key;
    for (let guard = 0; cur && guard < 32; guard++) {
      if (cur === ancestor) return true;
      const t = this.types.get(cur);
      if (!t?.parent) return false;
      cur = this.resolveType(t.parent, [t.pkg])?.key;
    }
    return false;
  }

  /** Types of `types` accepted by a declared set (a type is accepted by itself or any ancestor). */
  accepted(types, declared) {
    if (!declared) return types;
    return types.filter((t) => declared.some((d) => this.isSubtype(t, d)));
  }

  shortName(key) {
    return this.types.get(key)?.name || key.split("::").pop();
  }

  /** Merge the EMV2 subclauses of a classifier (type first, then implementation). */
  forClassifier(c) {
    if (!c) return null;
    if (this.cache.has(c)) return this.cache.get(c);
    const subclauses = this.model.annexSubclauses(c, "emv2").map((x) => ({ ...x, ast: x.annex.parsed })).filter((x) => x.ast?.kind === "emv2Subclause");
    if (!subclauses.length) {
      this.cache.set(c, null);
      return null;
    }
    const em = {
      classifier: c, useTypes: [], behavior: null, propagations: new Map(), flows: [], events: new Map(), states: new Map(),
      transitions: [], outgoing: [], composite: [], properties: [], subclauses,
    };
    for (const { ast, owner } of subclauses) {
      for (const u of ast.useTypes) if (!em.useTypes.includes(u)) em.useTypes.push(u);
      if (ast.useBehavior) em.behavior = this.behaviors.get(lc(ast.useBehavior)) || this.behaviors.get(lc(`${em.useTypes[0]}::${ast.useBehavior}`)) || { missing: ast.useBehavior };
      for (const p of ast.propagations) em.propagations.set(`${lc(p.point)}|${p.direction}`, { ...p, owner });
      em.flows.push(...ast.flows.map((f) => ({ ...f, owner })));
      for (const e of ast.events) em.events.set(lc(e.name), e);
      em.transitions.push(...ast.transitions);
      em.outgoing.push(...ast.outgoing);
      em.composite.push(...ast.composite);
      em.properties.push(...ast.properties);
    }
    if (em.behavior && !em.behavior.missing) {
      for (const e of em.behavior.events) if (!em.events.has(lc(e.name))) em.events.set(lc(e.name), e);
      for (const s of em.behavior.states) em.states.set(lc(s.name), s);
      em.transitions = [...em.behavior.transitions.map((t) => ({ ...t, fromLibrary: true })), ...em.transitions];
    }
    em.initial = [...em.states.values()].find((s) => s.initial)?.name || null;
    em.inTypes = (point) => this.expand(em.propagations.get(`${lc(point)}|in`)?.types, em.useTypes);
    em.outTypes = (point) => this.expand(em.propagations.get(`${lc(point)}|out`)?.types, em.useTypes);
    em.hasIn = (point) => em.propagations.has(`${lc(point)}|in`) && !em.propagations.get(`${lc(point)}|in`).not;
    em.hasOut = (point) => em.propagations.has(`${lc(point)}|out`) && !em.propagations.get(`${lc(point)}|out`).not;
    this.cache.set(c, em);
    return em;
  }

  /** EMV2 property value on an instance for a target path such as `Failure` or `out1.ServiceOmission`. */
  property(inst, name, targets) {
    const em = this.forClassifier(inst.classifier);
    const wanted = targets.filter(Boolean).map(lc);
    let found = null;
    // Contained associations from enclosing EMV2 subclauses: `applies to sub.Failure`
    const chain = [];
    for (let p = inst.parent, rel = [inst.name]; p; rel = [p.name, ...rel], p = p.parent) chain.push({ anc: p, prefix: rel.join(".") });
    for (const { anc, prefix } of chain.reverse()) {
      const aem = this.forClassifier(anc.classifier);
      for (const pa of aem?.properties || []) {
        if (!propertyNameMatches(pa.name, name)) continue;
        if (pa.appliesTo.some((a) => wanted.some((w) => lc(a) === `${lc(prefix)}.${w}`))) return pa.value;
      }
    }
    for (const pa of em?.properties || []) {
      if (!propertyNameMatches(pa.name, name)) continue;
      if (!pa.appliesTo.length && !wanted.length) found = pa.value;
      if (pa.appliesTo.some((a) => wanted.includes(lc(a)))) found = pa.value;
    }
    return found;
  }
}

// ---- legality checks -------------------------------------------------------------------------

export function validateEmv2(model, report) {
  const em = new ErrorModel(model);
  for (const pkg of model.packages.values()) {
    for (const c of pkg.classifiers) {
      for (const annex of c.annexes) {
        const ast = annex.parsed;
        if (annex.lname !== "emv2" || ast?.kind !== "emv2Subclause") continue;
        const where = annex.loc;
        for (const u of ast.useTypes) if (!em.libraries.has(lc(u))) report("error", `EMV2: error type library '${u}' not found`, where);
        const merged = em.forClassifier(c);
        if (ast.useBehavior && merged?.behavior?.missing) report("error", `EMV2: error behavior '${ast.useBehavior}' not found`, where);
        const checkTypes = (set, loc) => {
          for (const el of set || []) for (const t of el.types) {
            if (lc(t) !== "noerror" && !em.resolveType(t, merged.useTypes)) report("error", `EMV2: unknown error type '${t}'`, loc || where);
          }
        };
        for (const p of ast.propagations) {
          checkTypes(p.types, p.loc);
          const head = p.point.split(".")[0];
          if (!SPECIAL_POINTS.has(lc(head)) && !model.findFeature(c, head)) report("error", `EMV2: propagation point '${p.point}' is not a feature of '${c.name}'`, p.loc);
        }
        for (const f of ast.flows) {
          checkTypes(f.inTypes, f.loc);
          checkTypes(f.outTypes, f.loc);
          if (f.in && lc(f.in) !== "all" && !merged.hasIn(f.in)) report("error", `EMV2: error flow '${f.name}' uses '${f.in}', which has no incoming propagation`, f.loc);
          if (f.out && lc(f.out) !== "all" && !merged.hasOut(f.out)) report("error", `EMV2: error flow '${f.name}' uses '${f.out}', which has no outgoing propagation`, f.loc);
        }
        const stateOk = (ref) => !ref || ["all", "same"].includes(ref.state) || merged.states.has(lc(ref.state));
        const checkCondition = (cond, loc) => {
          if (!cond) return;
          if (cond.op === "ref") {
            const name = cond.path.join(".");
            if (cond.path.length === 1 && (merged.events.has(lc(name)) || merged.hasIn(name) || merged.states.has(lc(name)))) return;
            if (cond.path.length >= 1 && merged.hasIn(cond.path.join("."))) return;
            report("error", `EMV2: '${name}' is not an error event or incoming propagation of '${c.name}'`, cond.loc || loc);
          }
          for (const a of cond.args || []) checkCondition(a, loc);
        };
        for (const t of ast.transitions) {
          if (!stateOk(t.src) || !stateOk(t.dst)) report("error", `EMV2: transition ${t.name || ""} refers to an unknown error state`, t.loc);
          checkCondition(t.condition, t.loc);
        }
        for (const o of ast.outgoing) {
          if (!stateOk(o.src)) report("error", `EMV2: outgoing propagation refers to unknown state '${o.src.state}'`, o.loc);
          if (!merged.hasOut(o.point) && lc(o.point) !== "all") report("error", `EMV2: '${o.point}' has no outgoing propagation declared`, o.loc);
          checkCondition(o.condition, o.loc);
        }
        for (const r of ast.composite) {
          if (!stateOk(r.dst)) report("error", `EMV2: composite rule targets unknown state '${r.dst.state}'`, r.loc);
          const walk = (cond) => {
            if (!cond) return;
            if (cond.op === "ref") {
              const [sub, state] = cond.path;
              const sc = model.allSubcomponents(c).find((s) => lc(s.name) === lc(sub));
              if (!sc) report("error", `EMV2: composite rule refers to unknown subcomponent '${sub}'`, cond.loc || r.loc);
              else if (state) {
                const sem = em.forClassifier(sc._classifier);
                if (sem && !sem.states.has(lc(state))) report("error", `EMV2: '${sub}' has no error state '${state}'`, cond.loc || r.loc);
              }
            }
            for (const a of cond.args || []) walk(a);
          };
          walk(r.condition);
        }
      }
    }
  }
}

// ---- propagation ------------------------------------------------------------------------------

const typesText = (em, keys) => `{${keys.map((k) => em.shortName(k)).join(", ")}}`;

function boundComponents(model, root, target) {
  const out = [];
  for (const inst of root.walk()) {
    const v = instanceProperty(model, inst, "Actual_Processor_Binding") || instanceProperty(model, inst, "Actual_Memory_Binding");
    const refs = v?.type === "list" ? v.items : v ? [v] : [];
    for (const r of refs) {
      if (r.type !== "reference") continue;
      let cur = root;
      for (const part of r.path.split(".")) cur = cur?.child(part);
      if (cur === target) out.push(inst);
    }
  }
  return out;
}

/** All error sources in the instance hierarchy. */
export function errorSources(em, root) {
  const sources = [];
  for (const inst of root.walk()) {
    const cem = em.forClassifier(inst.classifier);
    if (!cem) continue;
    for (const f of cem.flows.filter((x) => x.flowKind === "source")) {
      const types = f.outTypes ? em.expand(f.outTypes, cem.useTypes) : cem.outTypes(f.out);
      sources.push({ inst, point: f.out, types, cause: f.when?.state ? `in state ${f.when.state}` : "error source", name: f.name, flow: f, state: f.when?.state || null });
    }
    for (const o of cem.outgoing) {
      const types = o.types ? em.expand(o.types, cem.useTypes) : cem.outTypes(o.point);
      if (o.src.state && o.src.state !== "all" && o.src.state === cem.initial && !o.condition) continue;
      sources.push({ inst, point: o.point, types, cause: o.src.state && o.src.state !== "all" ? `in state ${o.src.state}` : "propagation", name: o.name || `${o.src.state}→${o.point}`, state: o.src.state, outgoing: o });
    }
  }
  return sources;
}

/** Follow a propagation from (inst, point, types); returns complete paths. */
export function propagate(em, model, root, inst, point, types, { maxDepth = 40 } = {}) {
  const paths = [];
  const walk = (cur, pt, tys, steps, seen) => {
    const key = `${cur.qualifiedPath}|${lc(pt)}|${tys.join(",")}`;
    if (seen.has(key) || steps.length > maxDepth) return paths.push([...steps, { end: "cycle", text: "propagation cycle" }]);
    seen = new Set(seen).add(key);
    if (lc(pt) === "bindings" || lc(pt) === "binding") {
      const bound = boundComponents(model, root, cur);
      if (!bound.length) return paths.push([...steps, { end: "unbound", text: `no components bound to ${cur.qualifiedPath}` }]);
      for (const b of bound) enter(b, "processor", tys, steps, seen);
      return;
    }
    const parent = cur.parent;
    if (!parent) return paths.push([...steps, { end: "boundary", text: `leaves the system at ${pt} ${typesText(em, tys)}` }]);
    const conns = parent.connections.filter((c) => (c.src.component === cur && lc(c.src.feature?.name) === lc(pt)) || (c.bidirectional && c.dst.component === cur && lc(c.dst.feature?.name) === lc(pt)));
    if (!conns.length) return paths.push([...steps, { end: "unconnected", text: `${cur.qualifiedPath}.${pt} is not connected` }]);
    for (const c of conns) {
      const far = c.src.component === cur && lc(c.src.feature?.name) === lc(pt) ? c.dst : c.src;
      const step = { kind: "connection", text: `${c.name}: ${c.src.name} → ${c.dst.name}` };
      if (far.component === parent) {
        const pem = em.forClassifier(parent.classifier);
        if (!parent.parent) {
          paths.push([...steps, step, { inst: parent, point: far.feature.name, types: tys, text: `${parent.name}.${far.feature.name} ${typesText(em, tys)}` }, { end: "boundary", text: `system output ${far.feature.name}` }]);
        } else if (pem?.hasOut(far.feature.name)) {
          const ok = em.accepted(tys, pem.outTypes(far.feature.name));
          if (ok.length) walk(parent, far.feature.name, ok, [...steps, step, { inst: parent, point: far.feature.name, types: ok, text: `${parent.qualifiedPath}.${far.feature.name} ${typesText(em, ok)}` }], seen);
        } else paths.push([...steps, step, { end: "undeclared", text: `${parent.qualifiedPath}.${far.feature.name} declares no outgoing propagation` }]);
      } else if (far.component) {
        enter(far.component, far.feature?.name, tys, [...steps, step], seen);
      }
    }
  };
  const enter = (target, pt, tys, steps, seen) => {
    // Composite target: follow its own inner connections from the entry feature first.
    const inner = target.connections.filter((c) => c.src.component === target && lc(c.src.feature?.name) === lc(pt));
    if (inner.length) {
      for (const c of inner) {
        const step = { kind: "connection", text: `${c.name}: ${c.src.name} → ${c.dst.name}` };
        if (c.dst.component && c.dst.component !== target) enter(c.dst.component, c.dst.feature?.name, tys, [...steps, { inst: target, point: pt, types: tys, text: `${target.qualifiedPath}.${pt} ${typesText(em, tys)}` }, step], seen);
      }
      return;
    }
    const tem = em.forClassifier(target.classifier);
    const here = { inst: target, point: pt, types: tys, text: `${target.qualifiedPath}.${pt} ${typesText(em, tys)}` };
    if (!tem || !tem.hasIn(pt)) return paths.push([...steps, here, { end: "unhandled", text: `not handled: ${target.qualifiedPath}.${pt} declares no incoming propagation` }]);
    const accepted = em.accepted(tys, tem.inTypes(pt));
    if (!accepted.length) return paths.push([...steps, here, { end: "rejected", text: `${typesText(em, tys)} not accepted by ${target.qualifiedPath}.${pt}` }]);
    here.types = accepted;
    here.text = `${target.qualifiedPath}.${pt} ${typesText(em, accepted)}`;
    let handled = false;
    for (const f of tem.flows) {
      if (lc(f.in) !== lc(pt) && lc(f.in) !== "all") continue;
      const inTys = f.inTypes ? em.accepted(accepted, em.expand(f.inTypes, tem.useTypes)) : accepted;
      if (!inTys.length) continue;
      handled = true;
      if (f.flowKind === "sink") {
        paths.push([...steps, here, { end: "sink", text: `contained by error sink ${f.name} in ${target.qualifiedPath}` }]);
      } else if (f.flowKind === "path") {
        const outTys = f.outTypes ? em.expand(f.outTypes, tem.useTypes) : em.accepted(inTys, tem.outTypes(f.out));
        if (outTys.length) walk(target, f.out, outTys, [...steps, here, { kind: "path", text: `error path ${f.name}` }, { inst: target, point: f.out, types: outTys, text: `${target.qualifiedPath}.${f.out} ${typesText(em, outTys)}` }], seen);
      }
    }
    if (!handled) {
      const affects = tem.transitions.filter((t) => condRefs(t.condition).some((r) => lc(r) === lc(pt)));
      paths.push([...steps, here, affects.length
        ? { end: "state", text: `changes ${target.qualifiedPath} to ${[...new Set(affects.map((t) => t.dst.state))].join(" / ")}` }
        : { end: "absorbed", text: `no error path from ${pt} in ${target.qualifiedPath}` }]);
    }
  };
  const start = { inst, point, types, text: `${inst.qualifiedPath}.${point} ${typesText(em, types)}` };
  walk(inst, point, types, [start], new Set());
  return paths;
}

function condRefs(cond) {
  if (!cond) return [];
  if (cond.op === "ref") return [cond.path.join(".")];
  return (cond.args || []).flatMap(condRefs);
}

// ---- probabilities ----------------------------------------------------------------------------

export function occurrence(em, inst, targets) {
  const v = em.property(inst, "EMV2::OccurrenceDistribution", targets);
  if (v?.type === "record") {
    const p = v.fields.probabilityvalue;
    if (p?.type === "number") return p.value;
    const rate = v.fields.occurrencerate;
    if (rate?.type === "number") return rate.value;
  }
  return null;
}

/** Probability of entering error state `state` from the events of its incoming transitions (rare-event sum). */
function stateProbability(em, inst, cem, state) {
  let p = 0, known = false;
  for (const t of cem.transitions) {
    if (lc(t.dst.state) !== lc(state)) continue;
    for (const r of condRefs(t.condition)) {
      if (!cem.events.has(lc(r))) continue;
      const q = occurrence(em, inst, [r]);
      if (q !== null) {
        p += q;
        known = true;
      }
    }
  }
  return known ? Math.min(1, p) : null;
}

// ---- FMEA --------------------------------------------------------------------------------------

function severityText(v) {
  if (!v) return "";
  return formatValue(v).replace(/^ARP4761::|^MILSTD882::/i, "");
}

export function fmea(em, model, root) {
  const rows = [];
  let n = 0;
  for (const src of errorSources(em, root)) {
    const cem = em.forClassifier(src.inst.classifier);
    const paths = propagate(em, model, root, src.inst, src.point, src.types);
    const typeNames = src.types.map((t) => em.shortName(t));
    const prob = src.state ? stateProbability(em, src.inst, cem, src.state) ?? occurrence(em, src.inst, [src.name]) : occurrence(em, src.inst, [src.name]);
    for (const path of paths) {
      const steps = path.filter((s) => s.inst);
      const end = path.at(-1);
      const target = typeNames.map((t) => `${src.point}.${t}`);
      rows.push({
        id: `FM-${++n}`,
        component: src.inst.qualifiedPath,
        failureMode: `${src.point} {${typeNames.join(", ")}}`,
        cause: src.cause,
        localEffect: steps[0]?.text || "",
        nextEffect: steps.find((s) => s.inst !== src.inst)?.text || "—",
        endEffect: end?.text || "",
        endKind: end?.end,
        severity: severityText(em.property(src.inst, "EMV2::Severity", [...target, src.name, src.state])),
        likelihood: severityText(em.property(src.inst, "EMV2::Likelihood", [...target, src.name, src.state])),
        probability: prob,
        detection: formatValue(em.property(src.inst, "EMV2::DetectionMechanism", [...target, src.name]) || null).replace(/^"|"$/g, ""),
      });
    }
  }
  return rows;
}

// ---- hazards ----------------------------------------------------------------------------------

export function hazards(em, root) {
  const rows = [];
  for (const inst of root.walk()) {
    const cem = em.forClassifier(inst.classifier);
    for (const pa of cem?.properties || []) {
      if (!propertyNameMatches(pa.name, "EMV2::Hazards")) continue;
      const items = pa.value?.type === "list" ? pa.value.items : [pa.value];
      for (const rec of items) {
        if (rec?.type !== "record") continue;
        const f = (k) => {
          const v = rec.fields[lc(k)];
          if (!v) return "";
          if (v.type === "string") return v.value;
          if (v.type === "list") return v.items.map((x) => (x.type === "string" ? x.value : formatValue(x))).join(", ");
          return severityText(v);
        };
        rows.push({
          id: f("CrossReference") || `HZ-${rows.length + 1}`, title: f("HazardTitle"), description: f("Description"),
          component: inst.qualifiedPath, element: pa.appliesTo.join(", ") || "(component)", failure: f("Failure"),
          effect: f("FailureEffect"), phases: f("Phases"), severity: f("Severity"), likelihood: f("Likelihood"),
          risk: f("Risk"), comment: f("Comment"),
        });
      }
    }
  }
  return rows;
}

// ---- fault tree ---------------------------------------------------------------------------------

/**
 * Build a fault tree for `inst` being in error state `state` (composite or component behavior),
 * or for an outgoing propagation `point{types}` of the root.
 * Nodes: { kind: 'or'|'and'|'vote'|'basic'|'undeveloped', label, children, k, p, id }
 */
export function faultTree(em, model, root, top) {
  const basics = new Map();
  const basic = (inst, name, label) => {
    const id = `${inst.qualifiedPath}.${name}`.replace(/[^\w.]/g, "_");
    if (!basics.has(id)) basics.set(id, { kind: "basic", id, label, p: occurrence(em, inst, [name]) });
    return basics.get(id);
  };
  const gate = (kind, label, children, extra = {}) => {
    const kids = children.filter(Boolean);
    if (!kids.length) return { kind: "undeveloped", label: `${label} (no cause modelled)` };
    if (kids.length === 1 && kind !== "vote") return kids[0];
    return { kind, label, children: kids, ...extra };
  };

  const inState = (inst, state, seen) => {
    const key = `S|${inst.qualifiedPath}|${lc(state)}`;
    if (seen.has(key)) return null;
    seen = new Set(seen).add(key);
    const cem = em.forClassifier(inst.classifier);
    const label = `${inst.qualifiedPath} in ${state}`;
    if (!cem) return { kind: "undeveloped", label: `${label} (no error model)` };
    const rules = cem.composite.filter((r) => lc(r.dst.state) === lc(state));
    if (rules.length && inst.children.length) {
      return gate("or", label, rules.map((r) => compositeCond(inst, r.condition, seen)));
    }
    const causes = cem.transitions.filter((t) => lc(t.dst.state) === lc(state)).map((t) => transitionCond(inst, cem, t.condition, seen));
    return gate("or", label, causes);
  };

  const compositeCond = (inst, cond, seen) => {
    if (!cond) return null;
    if (cond.op === "and" || cond.op === "or") return gate(cond.op, cond.op.toUpperCase(), flatten(cond, cond.op).map((c) => compositeCond(inst, c, seen)));
    if (cond.op === "ormore" || cond.op === "orless") return gate("vote", `${cond.count} ${cond.op} of ${cond.args.length}`, cond.args.map((c) => compositeCond(inst, c, seen)), { k: cond.op === "ormore" ? cond.count : 1 });
    if (cond.op === "ref") {
      const [sub, state] = cond.path;
      const child = inst.child(sub);
      if (!child) return { kind: "undeveloped", label: `${sub}.${state}` };
      return inState(child, state, seen);
    }
    return null;
  };

  const transitionCond = (inst, cem, cond, seen) => {
    if (!cond) return null;
    if (cond.op === "and" || cond.op === "or") return gate(cond.op, cond.op.toUpperCase(), flatten(cond, cond.op).map((c) => transitionCond(inst, cem, c, seen)));
    if (cond.op === "ormore") return gate("vote", `${cond.count} ormore`, cond.args.map((c) => transitionCond(inst, cem, c, seen)), { k: cond.count });
    if (cond.op === "ref") {
      const name = cond.path.join(".");
      if (cem.events.has(lc(name))) return basic(inst, name, `${inst.qualifiedPath}: ${name}`);
      if (cem.hasIn(name)) {
        const types = cond.types ? em.expand(cond.types, cem.useTypes) : cem.inTypes(name);
        return incoming(inst, name, types, seen);
      }
    }
    return null;
  };

  /** Why does `point{types}` arrive at `inst`? Look at what is connected to it. */
  const incoming = (inst, point, types, seen) => {
    const key = `I|${inst.qualifiedPath}|${lc(point)}|${types.join(",")}`;
    if (seen.has(key)) return null;
    seen = new Set(seen).add(key);
    const label = `${inst.qualifiedPath}.${point} ${typesText(em, types)} received`;
    const parent = inst.parent;
    const causes = [];
    if (lc(point) === "processor" || lc(point) === "memory") {
      for (const target of root.walk()) {
        if (!boundComponents(model, root, target).includes(inst)) continue;
        causes.push(outgoingCause(target, "bindings", types, seen));
      }
    }
    if (parent) {
      for (const c of parent.connections) {
        if (c.dst.component !== inst || lc(c.dst.feature?.name) !== lc(point)) continue;
        if (c.src.component === parent) causes.push(parent.parent ? incoming(parent, c.src.feature.name, types, seen) : { kind: "undeveloped", label: `external input ${c.src.feature.name} ${typesText(em, types)}` });
        else if (c.src.component) causes.push(outgoingCause(c.src.component, c.src.feature.name, types, seen));
      }
    }
    return gate("or", label, causes);
  };

  /** Why does `inst` emit `point{types}`? Error sources, error paths and state-based propagations. */
  const outgoingCause = (inst, point, types, seen) => {
    const key = `O|${inst.qualifiedPath}|${lc(point)}|${types.join(",")}`;
    if (seen.has(key)) return null;
    seen = new Set(seen).add(key);
    const cem = em.forClassifier(inst.classifier);
    const label = `${inst.qualifiedPath}.${point} ${typesText(em, types)} emitted`;
    // Composite component: the error comes from inside.
    const inner = inst.connections.filter((c) => c.dst.component === inst && lc(c.dst.feature?.name) === lc(point) && c.src.component !== inst);
    if (inner.length) return gate("or", label, inner.map((c) => outgoingCause(c.src.component, c.src.feature.name, types, seen)));
    if (!cem) return { kind: "undeveloped", label: `${label} (no error model)` };
    const causes = [];
    for (const f of cem.flows) {
      if (lc(f.out) !== lc(point) && lc(f.out) !== "all") continue;
      const outTys = f.outTypes ? em.expand(f.outTypes, cem.useTypes) : cem.outTypes(point);
      if (!types.some((t) => outTys.some((o) => em.isSubtype(o, t) || em.isSubtype(t, o)))) continue;
      if (f.flowKind === "source") causes.push(f.when?.state ? inState(inst, f.when.state, seen) : basic(inst, f.name, `${inst.qualifiedPath}: error source ${f.name}`));
      if (f.flowKind === "path") {
        const inTys = f.inTypes ? em.expand(f.inTypes, cem.useTypes) : cem.inTypes(f.in);
        causes.push(incoming(inst, f.in, inTys, seen));
      }
    }
    for (const o of cem.outgoing) {
      if (lc(o.point) !== lc(point)) continue;
      const oTys = o.types ? em.expand(o.types, cem.useTypes) : cem.outTypes(point);
      if (!types.some((t) => oTys.some((x) => em.isSubtype(x, t) || em.isSubtype(t, x)))) continue;
      const parts = [];
      if (o.src.state && !["all", "same"].includes(o.src.state)) parts.push(inState(inst, o.src.state, seen));
      if (o.condition) parts.push(transitionCond(inst, cem, o.condition, seen));
      causes.push(gate("and", `${o.src.state} and condition`, parts));
    }
    return gate("or", label, causes);
  };

  const tree = top.state ? inState(top.inst, top.state, new Set()) : outgoingCause(top.inst, top.point, top.types, new Set());
  const cuts = minimalCutSets(tree);
  const pOf = (cs) => cs.reduce((acc, b) => (acc === null || b.p === null ? null : acc * b.p), 1);
  const probs = cuts.map(pOf);
  const topP = probs.every((p) => p !== null) ? 1 - probs.reduce((acc, p) => acc * (1 - p), 1) : null;
  return { tree, cuts: cuts.map((cs, i) => ({ events: cs, p: probs[i] })), probability: topP, basics: [...basics.values()] };
}

function flatten(cond, op) {
  return cond.op === op ? cond.args.flatMap((a) => flatten(a, op)) : [cond];
}

/** MOCUS-style minimal cut sets with subsumption; vote gates expand to OR of AND combinations. */
export function minimalCutSets(node, limit = 2000) {
  const sets = (n) => {
    if (!n) return [];
    if (n.kind === "basic") return [[n]];
    if (n.kind === "undeveloped") return [[{ kind: "basic", id: `U_${n.label.replace(/\W+/g, "_")}`, label: n.label, p: null, undeveloped: true }]];
    const kids = n.children.map(sets);
    if (n.kind === "or") return kids.flat();
    if (n.kind === "and") return kids.reduce((acc, ks) => acc.flatMap((a) => ks.map((b) => [...a, ...b])).slice(0, limit), [[]]);
    if (n.kind === "vote") {
      const out = [];
      const choose = (start, picked) => {
        if (picked.length === n.k) {
          out.push(...picked.reduce((acc, ks) => acc.flatMap((a) => ks.map((b) => [...a, ...b])), [[]]));
          return;
        }
        for (let i = start; i < kids.length; i++) choose(i + 1, [...picked, kids[i]]);
      };
      choose(0, []);
      return out.slice(0, limit);
    }
    return [];
  };
  const uniq = sets(node).map((cs) => [...new Map(cs.map((b) => [b.id, b])).values()]);
  uniq.sort((a, b) => a.length - b.length);
  const minimal = [];
  for (const cs of uniq) {
    const ids = new Set(cs.map((b) => b.id));
    if (minimal.some((m) => m.every((b) => ids.has(b.id)))) continue;
    minimal.push(cs);
  }
  return minimal;
}

/** Open-PSA Model Exchange Format (MEF) XML for a fault tree. */
export function toOpenPsa(name, result) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const gates = [];
  let n = 0;
  const ref = (node) => {
    if (node.kind === "basic") return `<basic-event name="${esc(node.id)}"/>`;
    if (node.kind === "undeveloped") return `<house-event name="${esc(`U_${node.label.replace(/\W+/g, "_")}`)}"/>`;
    const id = `G${++n}`;
    const body = node.children.map(ref).join("");
    const op = node.kind === "vote" ? `<atleast min="${node.k}">${body}</atleast>` : `<${node.kind}>${body}</${node.kind}>`;
    gates.push(`    <define-gate name="${id}">\n      <label>${esc(node.label)}</label>\n      ${op}\n    </define-gate>`);
    return `<gate name="${id}"/>`;
  };
  const topRef = ref(result.tree);
  const topGate = result.tree.kind === "basic" || result.tree.kind === "undeveloped"
    ? `    <define-gate name="TOP">\n      ${topRef}\n    </define-gate>`
    : null;
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', "<opsa-mef>", `  <define-fault-tree name="${esc(name)}">`];
  if (topGate) lines.push(topGate);
  lines.push(...gates.reverse(), "  </define-fault-tree>", "  <model-data>");
  for (const b of result.basics) {
    lines.push(`    <define-basic-event name="${esc(b.id)}">\n      <label>${esc(b.label)}</label>${b.p !== null ? `\n      <float value="${b.p}"/>` : ""}\n    </define-basic-event>`);
  }
  lines.push("  </model-data>", "</opsa-mef>");
  return lines.join("\n") + "\n";
}
