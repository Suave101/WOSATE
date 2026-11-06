// Declarative AADL model: parses workspace files, resolves names, runs the
// core legality checks, and dispatches annex text to the plugin that owns it.

import { parseAadl } from "./aadl-parser.js";
import { PREDECLARED_SETS, KNOWN_UNLOADED_PROPERTY_SETS } from "./library.js";

const lc = (s) => (s || "").toLowerCase();

export function propertyNameMatches(assocName, query) {
  const a = lc(assocName);
  const q = lc(query);
  if (a === q) return true;
  const aShort = a.includes("::") ? a.split("::")[1] : a;
  const qShort = q.includes("::") ? q.split("::")[1] : q;
  if (a.includes("::") && q.includes("::")) return false;
  return aShort === qShort;
}

/** The value of the last matching association (later associations override earlier ones). */
export function findProperty(assocs, name) {
  let found = null;
  for (const pa of assocs || []) {
    if (pa.appliesTo.length === 0 && propertyNameMatches(pa.name, name)) found = pa;
  }
  return found;
}

export class Model {
  constructor() {
    this.files = [];
    this.packages = new Map();
    this.propertySets = new Map();
    this.diagnostics = [];
  }

  report(severity, message, where, source = "validation") {
    const d = { severity, message, source, file: where?.file, line: where?.line || 1, col: where?.col || 1 };
    this.diagnostics.push(d);
    return d;
  }

  get classifiers() {
    const all = [];
    for (const pkg of this.packages.values()) all.push(...pkg.classifiers);
    return all;
  }

  get implementations() {
    return this.classifiers.filter((c) => c.kind === "componentImpl");
  }

  qualifiedName(c) {
    return `${c.pkg}::${c.name}`;
  }

  findPackage(name) {
    return this.packages.get(lc(name)) || null;
  }

  /**
   * Resolve a classifier reference (`Pkg::Name`, `Name`, `Name.Impl`) as seen from package `fromPkg`.
   * Returns { classifier, error } so callers can report precise problems.
   */
  lookupClassifier(refName, fromPkgName) {
    let pkgName = fromPkgName;
    let local = refName;
    const idx = refName.lastIndexOf("::");
    if (idx >= 0) {
      pkgName = refName.slice(0, idx);
      local = refName.slice(idx + 2);
    }
    const pkg = this.findPackage(pkgName);
    if (!pkg) return { classifier: null, error: `Package '${pkgName}' not found` };
    if (idx >= 0 && lc(pkgName) !== lc(fromPkgName)) {
      const from = this.findPackage(fromPkgName);
      if (from && !from.withs.some((w) => lc(w.name) === lc(pkgName))) {
        return { classifier: null, error: `Package '${pkgName}' is not listed in the with clause of '${fromPkgName}'` };
      }
    }
    const c = pkg.classifiers.find((k) => lc(k.name) === lc(local));
    if (!c) return { classifier: null, error: `Classifier '${refName}' not found` };
    if (lc(pkg.name) !== lc(fromPkgName) && c.visibility === "private") {
      return { classifier: null, error: `Classifier '${refName}' is private to package '${pkg.name}'` };
    }
    return { classifier: c, error: null };
  }

  resolveClassifier(refName, fromPkgName) {
    return this.lookupClassifier(refName, fromPkgName).classifier;
  }

  /** Find an implementation or type by its qualified name `Pkg::Name`. */
  findByQualifiedName(qname) {
    const idx = qname.lastIndexOf("::");
    if (idx < 0) return this.classifiers.find((c) => lc(c.name) === lc(qname)) || null;
    const pkg = this.findPackage(qname.slice(0, idx));
    return pkg?.classifiers.find((c) => lc(c.name) === lc(qname.slice(idx + 2))) || null;
  }

  typeOf(c) {
    if (!c) return null;
    if (c.kind === "componentType") return c;
    return c._type || null;
  }

  /** Classifier chain from `c` up through `extends`, most specific first. */
  extendsChain(c) {
    const chain = [];
    const seen = new Set();
    let cur = c;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      chain.push(cur);
      cur = cur._extends || null;
    }
    return chain;
  }

  /** Merge named members along the extends chain; refinements override inherited members. */
  mergeMembers(c, key) {
    const out = new Map();
    for (const k of this.extendsChain(c).reverse()) {
      for (const m of k[key] || []) out.set(lc(m.name), m);
    }
    return [...out.values()];
  }

  allFeatures(c) {
    const t = this.typeOf(c);
    return t ? this.mergeMembers(t, "features") : [];
  }

  findFeature(c, name) {
    return this.allFeatures(c).find((f) => lc(f.name) === lc(name)) || null;
  }

  allFlowSpecs(c) {
    const t = this.typeOf(c);
    return t ? this.mergeMembers(t, "flows") : [];
  }

  allSubcomponents(impl) {
    return impl?.kind === "componentImpl" ? this.mergeMembers(impl, "subcomponents") : [];
  }

  allConnections(impl) {
    return impl?.kind === "componentImpl" ? this.mergeMembers(impl, "connections") : [];
  }

  allCallSequences(impl) {
    return impl?.kind === "componentImpl" ? this.mergeMembers(impl, "callSequences") : [];
  }

  allModes(c) {
    const out = new Map();
    const t = this.typeOf(c);
    if (t) for (const k of this.extendsChain(t).reverse()) for (const m of k.modes || []) out.set(lc(m.name), m);
    if (c?.kind === "componentImpl") for (const k of this.extendsChain(c).reverse()) for (const m of k.modes || []) out.set(lc(m.name), m);
    return [...out.values()];
  }

  allFlowImpls(impl) {
    return impl?.kind === "componentImpl" ? this.mergeMembers(impl, "flows") : [];
  }

  /** Properties declared on a classifier, type first then implementation, each with inherited ones first. */
  classifierProperties(c) {
    const out = [];
    const t = this.typeOf(c);
    if (t) for (const k of this.extendsChain(t).reverse()) out.push(...k.properties);
    if (c?.kind === "componentImpl") for (const k of this.extendsChain(c).reverse()) out.push(...k.properties);
    return out;
  }

  /** Annex subclauses for a classifier: type subclauses first (with inherited), then implementation ones. */
  annexSubclauses(c, annexName) {
    const out = [];
    const t = this.typeOf(c);
    const pick = (k) => k.annexes.filter((a) => a.lname === lc(annexName)).forEach((a) => out.push({ annex: a, owner: k }));
    if (t) this.extendsChain(t).reverse().forEach(pick);
    if (c?.kind === "componentImpl") this.extendsChain(c).reverse().forEach(pick);
    return out;
  }

  annexLibraries(annexName) {
    const out = [];
    for (const pkg of this.packages.values()) {
      for (const a of pkg.annexLibraries) if (a.lname === lc(annexName)) out.push({ annex: a, pkg });
    }
    return out;
  }

  /** Find a property (or type / constant) definition: `Set::Name`, or an unqualified predeclared name. */
  propertyDefinition(name) {
    const sets = name.includes("::")
      ? [this.propertySets.get(lc(name.split("::")[0]))]
      : PREDECLARED_SETS.map((s) => this.propertySets.get(lc(s)));
    const short = lc(name.includes("::") ? name.split("::")[1] : name);
    for (const set of sets) {
      const def = set?.definitions.find((d) => lc(d.name) === short);
      if (def) return { set, def };
    }
    return null;
  }

  /** Follow a definition's type reference chain to the definition that spells out the type. */
  resolvedType(def, depth = 0) {
    if (!def?.typeRef || depth > 8) return def;
    const target = this.propertyDefinition(def.typeRef)?.def ||
      // unqualified type names may live in the same set as the definition
      [...this.propertySets.values()].flatMap((s) => s.definitions).find((d) => d.isType && lc(d.name) === lc(def.typeRef));
    return target ? this.resolvedType(target, depth + 1) : def;
  }

  enumLiteralsOf(def) {
    return this.resolvedType(def)?.enumLiterals || [];
  }

  unitsOf(def, depth = 0) {
    const t = this.resolvedType(def);
    if (!t || depth > 8) return [];
    if (t.units.length) return t.units;
    const m = t.typeText?.match(/units\s+([\w:]+)/i);
    if (!m) return [];
    const unitsType = this.propertyDefinition(m[1])?.def ||
      [...this.propertySets.values()].flatMap((s) => s.definitions).find((d) => lc(d.name) === lc(m[1].split("::").pop()));
    return unitsType ? this.unitsOf(unitsType, depth + 1) : [];
  }

  /** The data classifier's base representation, following extends: 'bool' | 'int' | 'real' | null. */
  dataRepresentation(c) {
    for (const k of this.extendsChain(c)) {
      const n = lc(k.name);
      if (lc(k.pkg) === "base_types") {
        if (n === "boolean") return "bool";
        if (n.startsWith("integer") || n.startsWith("unsigned") || n === "natural") return "int";
        if (n.startsWith("float")) return "real";
      }
      const rep = findProperty(k.properties, "Data_Model::Data_Representation");
      if (rep?.value?.type === "name") {
        const r = lc(rep.value.name);
        if (r === "boolean") return "bool";
        if (r === "integer") return "int";
        if (r === "float" || r === "fixed") return "real";
      }
    }
    return null;
  }
}

/**
 * Build a model from source files.
 * @param {{name:string,text:string}[]} files
 * @param {import('./plugin-host.js').PluginHost} [host]
 */
export function buildModel(files, host) {
  const model = new Model();
  model.files = files;
  for (const f of files) {
    const { units, diagnostics } = parseAadl(f.text, f.name);
    model.diagnostics.push(...diagnostics);
    for (const u of units) {
      const map = u.kind === "package" ? model.packages : model.propertySets;
      if (map.has(lc(u.name))) {
        model.report("error", `Duplicate ${u.kind === "package" ? "package" : "property set"} '${u.name}'`, u.loc);
        continue;
      }
      map.set(lc(u.name), u);
    }
  }
  resolve(model);
  parseAnnexes(model, host);
  validate(model);
  host?.validate(model);
  return model;
}

function resolve(model) {
  for (const pkg of model.packages.values()) {
    for (const w of pkg.withs) {
      const known = model.packages.has(lc(w.name)) || model.propertySets.has(lc(w.name)) ||
        KNOWN_UNLOADED_PROPERTY_SETS.some((p) => lc(p) === lc(w.name));
      if (!known) model.report("error", `Unknown package or property set '${w.name}' in with clause`, w.loc);
    }
    const seen = new Map();
    for (const c of pkg.classifiers) {
      if (seen.has(lc(c.name))) model.report("error", `Duplicate classifier '${c.name}' in package '${pkg.name}'`, c.loc);
      seen.set(lc(c.name), c);
    }
    for (const c of pkg.classifiers) {
      if (c.kind === "componentImpl") {
        const t = pkg.classifiers.find((k) => k.kind === "componentType" && lc(k.name) === lc(c.typeName));
        if (!t) model.report("error", `Component type '${c.typeName}' for implementation '${c.name}' not found`, c.loc);
        else if (t.category !== c.category) {
          model.report("error", `Implementation '${c.name}' is a ${c.category} but its type is a ${t.category}`, c.loc);
        }
        c._type = t || null;
      }
      if (c.extends) {
        const { classifier, error } = model.lookupClassifier(c.extends.name, pkg.name);
        if (!classifier) model.report("error", error, c.extends.loc);
        else if (classifier.kind !== c.kind) model.report("error", `'${c.name}' cannot extend '${c.extends.name}' (a ${classifier.kind === "componentType" ? "type" : "implementation"})`, c.extends.loc);
        else c._extends = classifier;
      }
    }
  }
  // Second pass: references that need _type/_extends in place.
  for (const pkg of model.packages.values()) {
    for (const c of pkg.classifiers) {
      for (const f of c.features || []) resolveRef(model, f, pkg, null);
      for (const s of c.subcomponents || []) resolveRef(model, s, pkg, s.category);
      for (const seq of c.callSequences || []) for (const call of seq.calls) resolveRef(model, call, pkg, "subprogram");
    }
  }
}

function resolveRef(model, member, pkg, category) {
  if (!member.classifier) return;
  const { classifier, error } = model.lookupClassifier(member.classifier.name, pkg.name);
  if (!classifier) {
    model.report("error", error, member.classifier.loc);
    return;
  }
  if (category && classifier.category !== category && classifier.category !== "abstract") {
    model.report("error", `Subcomponent '${member.name}' is declared as ${category} but '${member.classifier.name}' is a ${classifier.category}`, member.classifier.loc);
  }
  member._classifier = classifier;
}

function parseAnnexes(model, host) {
  const handle = (annex, context) => {
    const handler = host?.annexHandler(annex.lname);
    if (!handler) {
      model.report("info", `No installed plug-in handles annex '${annex.name}'; it is kept but not analysed`, annex.loc, "annex");
      return;
    }
    try {
      const result = handler.parse(annex.text, { ...context, loc: annex.bodyLoc || annex.loc });
      annex.parsed = result.ast;
      for (const d of result.diagnostics || []) model.diagnostics.push({ source: annex.lname, ...d });
    } catch (e) {
      model.report("error", `Annex '${annex.name}' plug-in failed: ${e.message}`, annex.loc, "annex");
    }
  };
  for (const pkg of model.packages.values()) {
    for (const a of pkg.annexLibraries) handle(a, { kind: "library", pkg });
    for (const c of pkg.classifiers) for (const a of c.annexes) handle(a, { kind: "subclause", owner: c, pkg });
  }
}

function validate(model) {
  for (const pkg of model.packages.values()) {
    for (const c of pkg.classifiers) {
      validateProperties(model, pkg, c.properties);
      if (c.kind === "componentType") {
        validateModes(model, c);
        const names = new Set();
        for (const f of c.features) {
          if (names.has(lc(f.name))) model.report("error", `Duplicate feature '${f.name}' in '${c.name}'`, f.loc);
          names.add(lc(f.name));
          validateProperties(model, pkg, f.properties);
        }
        for (const fs of c.flows) {
          for (const end of [fs.in, fs.out]) {
            if (end && !model.findFeature(c, end.split(".")[0])) {
              model.report("error", `Flow '${fs.name}' refers to unknown feature '${end}'`, fs.loc);
            }
          }
        }
      } else {
        validateImplementation(model, pkg, c);
      }
    }
  }
}

function validateModes(model, c) {
  if (!c.modes?.length) return;
  const initial = c.modes.filter((m) => m.initial);
  if (!c.requiresModes && initial.length !== 1) {
    model.report("error", `'${c.name}' must declare exactly one initial mode (found ${initial.length})`, c.modes[0].loc);
  }
  const names = new Set(c.modes.map((m) => lc(m.name)));
  for (const t of c.modeTransitions || []) {
    for (const end of [t.src, t.dst]) if (!names.has(lc(end))) model.report("error", `Mode transition '${t.name}' refers to unknown mode '${end}'`, t.loc);
    for (const trig of t.triggers) {
      const [head, tail] = trig.split(".");
      const ok = tail
        ? model.allSubcomponents(c).some((s) => lc(s.name) === lc(head) && s._classifier && model.findFeature(s._classifier, tail))
        : !!model.findFeature(c, head);
      if (!ok) model.report("error", `Mode transition '${t.name}': unknown trigger port '${trig}'`, t.loc);
    }
  }
}

function validateImplementation(model, pkg, impl) {
  validateModes(model, impl);
  const subs = model.allSubcomponents(impl);
  const subByName = new Map(subs.map((s) => [lc(s.name), s]));
  const names = new Set();
  for (const s of impl.subcomponents) {
    if (names.has(lc(s.name))) model.report("error", `Duplicate subcomponent '${s.name}' in '${impl.name}'`, s.loc);
    names.add(lc(s.name));
    validateProperties(model, pkg, s.properties);
  }

  const endFeature = (end, conn) => {
    if (end.context) {
      const sub = subByName.get(lc(end.context));
      if (!sub) {
        model.report("error", `Connection '${conn.name}' refers to unknown subcomponent '${end.context}'`, conn.loc);
        return null;
      }
      if (!sub._classifier) return null;
      const f = model.findFeature(sub._classifier, end.feature);
      if (!f) model.report("error", `Connection '${conn.name}': '${end.context}' has no feature '${end.feature}'`, conn.loc);
      return f ? { feature: f, inner: false } : null;
    }
    const f = model.findFeature(impl, end.feature);
    if (f) return { feature: f, inner: true };
    if (subByName.has(lc(end.feature))) return { subcomponent: subByName.get(lc(end.feature)) }; // access to a subcomponent
    model.report("error", `Connection '${conn.name}' refers to unknown feature '${end.feature}'`, conn.loc);
    return null;
  };

  for (const conn of impl.connections) {
    validateProperties(model, pkg, conn.properties);
    const src = endFeature(conn.src, conn);
    const dst = endFeature(conn.dst, conn);
    if (!src?.feature || !dst?.feature || conn.bidirectional) continue;
    if (!/port/.test(src.feature.featureKind || "") || !/port/.test(dst.feature.featureKind || "")) continue;
    // Outgoing direction of the source end: own features flow inward, subcomponent features outward.
    const srcOk = src.inner ? /in/.test(src.feature.direction) : /out/.test(src.feature.direction);
    const dstOk = dst.inner ? /out/.test(dst.feature.direction) : /in/.test(dst.feature.direction);
    const show = (e) => (e.context ? `${e.context}.${e.feature}` : e.feature);
    if (!srcOk) model.report("error", `Connection '${conn.name}': '${show(conn.src)}' (${src.feature.direction}) cannot be a connection source`, conn.loc);
    if (!dstOk) model.report("error", `Connection '${conn.name}': '${show(conn.dst)}' (${dst.feature.direction}) cannot be a connection destination`, conn.loc);
    if (src.feature._classifier && dst.feature._classifier && src.feature._classifier !== dst.feature._classifier) {
      model.report("warning", `Connection '${conn.name}' connects '${src.feature.classifier.name}' to '${dst.feature.classifier.name}'`, conn.loc);
    }
  }

  for (const fl of impl.flows) {
    for (const seg of fl.segments) {
      const [head] = seg.split(".");
      const known = subByName.has(lc(head)) || model.allConnections(impl).some((c) => lc(c.name) === lc(head)) ||
        model.allFlowSpecs(impl).some((f) => lc(f.name) === lc(head)) || model.findFeature(impl, head);
      if (!known) model.report("error", `Flow '${fl.name}' refers to unknown element '${seg}'`, fl.loc);
    }
  }
}

function validateProperties(model, pkg, assocs) {
  for (const pa of assocs || []) {
    const qualified = pa.name.includes("::");
    const set = qualified ? pa.name.split("::")[0] : null;
    if (qualified && KNOWN_UNLOADED_PROPERTY_SETS.some((p) => lc(p) === lc(set))) continue;
    if (qualified && !model.propertySets.has(lc(set))) {
      model.report("warning", `Property set '${set}' is not available (property '${pa.name}')`, pa.loc);
      continue;
    }
    const found = model.propertyDefinition(pa.name);
    if (!found) {
      model.report("error", qualified
        ? `Property '${pa.name}' is not defined in property set '${set}'`
        : `Property '${pa.name}' is not a predeclared property; qualify it with its property set`, pa.loc);
      continue;
    }
    const predeclared = PREDECLARED_SETS.some((p) => lc(p) === lc(found.set.name));
    if (qualified && !predeclared && lc(pkg.name) !== lc(set) && !pkg.withs.some((w) => lc(w.name) === lc(set))) {
      model.report("error", `Property set '${set}' is not listed in the with clause of '${pkg.name}'`, pa.loc);
    }
    checkValue(model, pa, found.def, pa.value);
  }
}

/** Check enumeration literals and units of a property value against its definition. */
function checkValue(model, pa, def, value) {
  if (!value) return;
  if (value.type === "list") {
    for (const item of value.items) checkValue(model, pa, def, item);
    return;
  }
  if (value.type === "range") {
    checkValue(model, pa, def, value.min);
    checkValue(model, pa, def, value.max);
    return;
  }
  const literals = model.enumLiteralsOf(def);
  if (literals.length && value.type === "name" && !value.name.includes("::")) {
    if (!literals.some((l) => lc(l) === lc(value.name)) && !model.propertyDefinition(value.name)?.def.isConstant) {
      model.report("error", `'${value.name}' is not a value of ${pa.name} (expected one of ${literals.join(", ")})`, pa.loc);
    }
  }
  const units = model.unitsOf(def);
  if (units.length && value.type === "number") {
    if (!value.unit) model.report("warning", `${pa.name} expects a unit (${units.join(", ")})`, pa.loc);
    else if (!units.some((u) => u === value.unit || lc(u) === lc(value.unit))) {
      model.report("error", `'${value.unit}' is not a unit of ${pa.name} (expected one of ${units.join(", ")})`, pa.loc);
    }
  }
}
