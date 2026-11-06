// System instance model: the component hierarchy rooted at a system
// implementation, with contained property associations applied (OSATE's
// "Instantiate" action).

import { propertyNameMatches } from "./model.js";

const lc = (s) => (s || "").toLowerCase();

export class ComponentInstance {
  constructor({ name, category, classifier, subcomponent, parent }) {
    this.name = name;
    this.category = category;
    this.classifier = classifier; // type or implementation (may be null)
    this.subcomponent = subcomponent; // declaring subcomponent (null for root)
    this.parent = parent;
    this.features = [];
    this.children = [];
    this.connections = [];
    this.flows = [];
    this.callSequences = [];
    this.modes = [];
    /** Contained associations targeting this instance (or one of its features), outermost first. */
    this.contained = [];
  }

  get path() {
    const parts = [];
    for (let c = this; c && c.parent; c = c.parent) parts.unshift(c.name);
    return parts.join(".");
  }

  get qualifiedPath() {
    return this.parent ? this.path : this.name;
  }

  child(name) {
    return this.children.find((c) => lc(c.name) === lc(name)) || null;
  }

  *walk() {
    yield this;
    for (const c of this.children) yield* c.walk();
  }
}

/**
 * Instantiate an implementation.
 * @param {import('./model.js').Model} model
 * @param {object} impl component implementation (usually a system implementation)
 */
export function instantiate(model, impl, { maxDepth = 32 } = {}) {
  const typeName = model.typeOf(impl)?.name || impl.typeName;
  const root = new ComponentInstance({
    name: `${impl.name.replace(".", "_")}_Instance`,
    category: impl.category,
    classifier: impl,
    subcomponent: null,
    parent: null,
  });
  root.typeName = typeName;
  const problems = [];
  build(model, root, impl, 0, maxDepth, problems);
  applyContained(root, root, model);
  return { root, problems };
}

function build(model, inst, classifier, depth, maxDepth, problems) {
  if (!classifier) return;
  inst.features = model.allFeatures(classifier).map((f) => ({ name: f.name, decl: f, direction: f.direction, kind: f.featureKind, owner: inst }));
  if (classifier.kind !== "componentImpl") return;
  if (depth >= maxDepth) {
    problems.push(`Instantiation stopped at depth ${maxDepth} (recursive containment?) at ${inst.path}`);
    return;
  }
  for (const sc of model.allSubcomponents(classifier)) {
    const child = new ComponentInstance({
      name: sc.name, category: sc.category, classifier: sc._classifier || null, subcomponent: sc, parent: inst,
    });
    inst.children.push(child);
    build(model, child, sc._classifier, depth + 1, maxDepth, problems);
  }
  for (const conn of model.allConnections(classifier)) {
    const endpoint = (e) => {
      const comp = e.context ? inst.child(e.context) : inst;
      const feature = comp?.features.find((f) => lc(f.name) === lc(e.feature)) || null;
      return { component: comp, feature, name: e.context ? `${e.context}.${e.feature}` : e.feature };
    };
    inst.connections.push({ name: conn.name, decl: conn, kind: conn.connectionKind, src: endpoint(conn.src), dst: endpoint(conn.dst), bidirectional: conn.bidirectional });
  }
  inst.flows = model.allFlowImpls(classifier);
  inst.callSequences = model.allCallSequences(classifier);
  inst.modes = model.allModes(classifier);
  inst.implementation = classifier;
}

/** Attach `applies to` associations declared in every implementation down the hierarchy. */
function applyContained(root, inst, model) {
  const assocs = [];
  if (inst.classifier) assocs.push(...model.classifierProperties(inst.classifier));
  if (inst.subcomponent) assocs.push(...inst.subcomponent.properties);
  for (const pa of assocs) {
    for (const path of pa.appliesTo) {
      const parts = path.split(".");
      let target = inst;
      let feature = null;
      for (let k = 0; k < parts.length && target; k++) {
        const next = target.child(parts[k]);
        if (next) target = next;
        else if (k === parts.length - 1) {
          feature = parts[k];
        } else target = null;
      }
      if (target) target.contained.push({ assoc: pa, feature, from: inst });
    }
  }
  for (const c of inst.children) applyContained(root, c, model);
}

/**
 * Look up a property value on a component instance (or one of its features / flow specs
 * / connections when `member` is given). Outer contained associations take precedence,
 * then the subcomponent declaration, then the classifier.
 */
export function instanceProperty(model, inst, name, member = null) {
  for (const { assoc, feature } of inst.contained) {
    if (lc(feature) === lc(member) && propertyNameMatches(assoc.name, name)) return assoc.value;
  }
  if (member) {
    const holders = [
      ...model.allFeatures(inst.classifier),
      ...model.allFlowSpecs(inst.classifier),
    ].filter((m) => lc(m.name) === lc(member));
    for (const h of holders) {
      const v = lastMatch(h.properties, name);
      if (v) return v;
    }
    const v = lastMatch(model.classifierProperties(inst.classifier).filter((pa) => pa.appliesTo.some((p) => lc(p) === lc(member))), name, true);
    return v;
  }
  if (inst.subcomponent) {
    const v = lastMatch(inst.subcomponent.properties, name);
    if (v) return v;
  }
  return inst.classifier ? lastMatch(model.classifierProperties(inst.classifier), name) : null;
}

function lastMatch(assocs, name, allowApplies = false) {
  let found = null;
  for (const pa of assocs || []) {
    if ((allowApplies || pa.appliesTo.length === 0) && propertyNameMatches(pa.name, name)) found = pa.value;
  }
  return found;
}

/**
 * Resolve a reference-valued property (e.g. Actual_Processor_Binding) on an instance to
 * component instances. Paths are relative to the component whose implementation declared
 * the association; bindings declared on an enclosing component are inherited (a process
 * bound to a processor binds its threads).
 */
export function referenceTargets(model, inst, name) {
  const resolve = (value, base) => {
    const refs = value?.type === "list" ? value.items : value ? [value] : [];
    const out = [];
    for (const r of refs) {
      if (r.type !== "reference") continue;
      let cur = base;
      for (const part of r.path.split(".")) cur = cur?.child(part);
      if (cur) out.push(cur);
    }
    return out;
  };
  for (const { assoc, feature, from } of inst.contained) {
    if (!feature && propertyNameMatches(assoc.name, name)) return resolve(assoc.value, from);
  }
  if (inst.subcomponent) {
    const v = lastMatch(inst.subcomponent.properties, name);
    if (v) return resolve(v, inst.parent);
  }
  const own = inst.classifier ? lastMatch(model.classifierProperties(inst.classifier), name) : null;
  if (own) return resolve(own, inst);
  return inst.parent ? referenceTargets(model, inst.parent, name) : [];
}

/** Connection bindings: `Actual_Connection_Binding => (reference (bus)) applies to conn`. */
export function connectionBindingTargets(model, owner, conn) {
  // `applies to` associations for a connection (from any ancestor) are attached to its owner.
  for (const { assoc, feature, from } of owner.contained) {
    if (lc(feature) === lc(conn.name) && propertyNameMatches(assoc.name, "Actual_Connection_Binding")) return refsFrom(assoc.value, from);
  }
  const v = lastMatch(conn.decl.properties, "Actual_Connection_Binding");
  return v ? refsFrom(v, owner) : [];
}

function refsFrom(value, base) {
  const refs = value?.type === "list" ? value.items : value ? [value] : [];
  return refs.filter((r) => r.type === "reference").map((r) => {
    let cur = base;
    for (const part of r.path.split(".")) cur = cur?.child(part);
    return cur;
  }).filter(Boolean);
}

/** Property value of a connection declared in an instance's implementation. */
export function connectionProperty(model, inst, conn, name) {
  for (const { assoc, feature } of inst.contained) {
    if (lc(feature) === lc(conn.name) && propertyNameMatches(assoc.name, name)) return assoc.value;
  }
  const v = lastMatch(conn.decl.properties, name);
  if (v) return v;
  return lastMatch(model.classifierProperties(inst.classifier).filter((pa) => pa.appliesTo.some((p) => lc(p) === lc(conn.name))), name, true);
}
