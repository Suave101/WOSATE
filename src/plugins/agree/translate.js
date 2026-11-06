// AGREE compositional translation: one component implementation plus the
// contracts of its direct subcomponents become a flat, typed Lustre-style
// program (inputs, defined locals, assertions, proof obligations).
//
// Rules (single layer, as in AGREE's "Verify Single Layer"):
//   * every data port becomes a stream: `port` (top level) or `sub__port`
//   * a connected destination port is defined as its source; unconnected inputs stay free
//   * top-level assumptions and `assert` statements are assumed
//   * a subcomponent's guarantees are assumed while its assumptions have always held
//   * top-level guarantees, lemmas and subcomponent assumptions are proof obligations

const lc = (s) => (s || "").toLowerCase();

export class TranslationError extends Error {
  constructor(message, loc) {
    super(message);
    this.loc = loc;
  }
}

const BOOL = "bool", INT = "int", REAL = "real";

// ---- IR constructors --------------------------------------------------------

const V = (name, type) => ({ op: "var", name, type });
const L = (type, v) => ({ op: "lit", type, v });
const N = (op, type, ...args) => ({ op, type, args });

export function andAll(es) {
  if (!es.length) return L(BOOL, true);
  return es.reduce((a, b) => N("and", BOOL, a, b));
}

export class Program {
  constructor(name) {
    this.name = name;
    this.vars = new Map(); // name -> { name, type, expr|null, role, label, scope }
    this.asserts = []; // { expr, label }
    this.props = []; // { id, name, expr, kind, component, desc, loc }
    this.warnings = [];
  }

  declare(name, type, { expr = null, role = "input", label = name, scope = "", visible = true } = {}) {
    if (this.vars.has(name)) throw new TranslationError(`Duplicate stream '${name}'`);
    const v = { name, type, expr, role, label, scope, visible };
    this.vars.set(name, v);
    return v;
  }

  get inputs() {
    return [...this.vars.values()].filter((v) => !v.expr);
  }

  get locals() {
    return [...this.vars.values()].filter((v) => v.expr);
  }
}

/** Collect AGREE specs of a classifier from the model (type subclauses then impl subclauses). */
function specsOf(model, classifier, { typeOnly = false } = {}) {
  const out = [];
  const t = model.typeOf(classifier);
  for (const { annex, owner } of model.annexSubclauses(classifier, "agree")) {
    if (typeOnly && owner !== t && owner.kind === "componentImpl") continue;
    if (!annex.parsed) continue;
    for (const s of annex.parsed.specs) out.push({ ...s, owner, level: owner.kind === "componentImpl" ? "impl" : "type" });
  }
  return out;
}

/** Library declarations (consts, nodes, funs) indexed by `pkg::name` and plain `name`. */
function libraryIndex(model) {
  const idx = new Map();
  for (const { annex, pkg } of model.annexLibraries("agree")) {
    for (const s of annex.parsed?.specs || []) {
      if (!["const", "node", "fun", "eq", "property"].includes(s.kind)) continue;
      const decl = { ...s, pkg: pkg.name };
      idx.set(lc(`${pkg.name}::${s.name}`), decl);
      idx.set(lc(`${pkg.name}.${s.name}`), decl);
      if (!idx.has(lc(s.name))) idx.set(lc(s.name), decl);
    }
  }
  return idx;
}

/**
 * Translate a component implementation into a Program.
 * @returns {{ program: Program, errors: {message, loc}[] }}
 */
export function translateImplementation(model, impl) {
  const tr = new Translator(model, impl);
  return tr.run();
}

class Translator {
  constructor(model, impl) {
    this.model = model;
    this.impl = impl;
    this.program = new Program(model.qualifiedName(impl));
    this.errors = [];
    this.library = libraryIndex(model);
    this.nodeCounter = 0;
    this.histCounter = 0;
  }

  error(message, loc) {
    this.errors.push({ message, loc });
  }

  attempt(fn) {
    try {
      return fn();
    } catch (e) {
      if (e instanceof TranslationError) {
        this.error(e.message, e.loc);
        return null;
      }
      throw e;
    }
  }

  // ---- types ------------------------------------------------------------------

  agreeType(typeAst, pkgName) {
    const n = lc(typeAst.name);
    if (n === "int" || n === "real" || n === "bool") return n;
    const c = this.model.resolveClassifier(typeAst.name, pkgName);
    if (!c) throw new TranslationError(`Unknown type '${typeAst.name}'`, typeAst.loc);
    const rep = this.model.dataRepresentation(c);
    if (!rep) throw new TranslationError(`Data type '${typeAst.name}' is not a Boolean, Integer or Float type (records and enumerations are not supported yet)`, typeAst.loc);
    return rep;
  }

  portType(feature) {
    if (!/data port|parameter/.test(feature.featureKind || "")) return null;
    if (!feature._classifier) return null;
    return this.model.dataRepresentation(feature._classifier);
  }

  // ---- scopes -------------------------------------------------------------------

  makeScope(classifier, prefix, label) {
    const pkgName = classifier.pkg;
    const scope = { classifier, prefix, label, pkgName, names: new Map(), subs: new Map(), consts: new Map(), decls: new Map() };
    for (const f of this.model.allFeatures(classifier)) {
      const type = this.portType(f);
      const name = prefix + f.name;
      if (!type) {
        scope.names.set(lc(f.name), { unsupported: `${f.featureKind || "feature"} '${f.name}' has no Boolean/Integer/Float data type` });
        continue;
      }
      const v = this.program.declare(name, type, { label: prefix ? `${label}.${f.name}` : f.name, scope: label, role: f.direction === "out" ? "output" : "input" });
      v.feature = f;
      scope.names.set(lc(f.name), { var: name, type });
    }
    return scope;
  }

  run() {
    const { model, impl, program } = this;
    const top = this.makeScope(impl, "", "");
    top.isTop = true;
    const subScopes = [];
    for (const sc of model.allSubcomponents(impl)) {
      if (!sc._classifier) {
        program.warnings.push(`Subcomponent '${sc.name}' has no classifier; it has no contract`);
        continue;
      }
      const scope = this.makeScope(sc._classifier, `${sc.name}__`, sc.name);
      scope.sub = sc;
      top.subs.set(lc(sc.name), scope);
      subScopes.push(scope);
    }

    // Connections define destination ports.
    for (const conn of model.allConnections(impl)) {
      if (conn.bidirectional || !/port|parameter/.test(conn.connectionKind)) continue;
      const end = (e) => {
        const s = e.context ? top.subs.get(lc(e.context)) : top;
        return s?.names.get(lc(e.feature));
      };
      const src = end(conn.src);
      const dst = end(conn.dst);
      if (!src?.var || !dst?.var) continue;
      const dv = program.vars.get(dst.var);
      if (dv.expr) {
        program.warnings.push(`Port '${dv.label}' has more than one incoming connection; only '${dv.connection}' is used`);
        continue;
      }
      if (src.type !== dst.type) {
        this.error(`Connection '${conn.name}' connects ${src.type} to ${dst.type}`, conn.loc);
        continue;
      }
      dv.expr = V(src.var, src.type);
      dv.role = "connected";
      dv.connection = conn.name;
    }

    const topSpecs = specsOf(model, impl);
    const subSpecs = subScopes.map((s) => ({ scope: s, specs: specsOf(model, s.classifier, { typeOnly: true }) }));

    // Phase 1: declare eq/property/const names so declaration order does not matter.
    this.declareLocals(top, topSpecs);
    for (const { scope, specs } of subSpecs) this.declareLocals(scope, specs);

    // Phase 2: definitions.
    this.defineLocals(top, topSpecs);
    for (const { scope, specs } of subSpecs) this.defineLocals(scope, specs);

    // Phase 3: contracts.
    const label = (s) => s.id ? `${s.id}${s.desc ? ": " + s.desc : ""}` : s.desc || s.kind;
    for (const s of topSpecs) {
      if (s.kind === "assume") {
        const e = this.attempt(() => this.boolExpr(s.expr, top));
        if (e) program.asserts.push({ expr: e, label: `assume ${label(s)}` });
      } else if (s.kind === "assert") {
        const e = this.attempt(() => this.boolExpr(s.expr, top));
        if (e) program.asserts.push({ expr: e, label: `assert ${label(s)}` });
      } else if (s.kind === "guarantee" || s.kind === "lemma") {
        const e = this.attempt(() => this.boolExpr(s.expr, top));
        if (e) program.props.push({ kind: s.kind, component: "", desc: label(s), expr: e, loc: s.loc });
      }
    }
    for (const { scope, specs } of subSpecs) {
      const assumes = [];
      for (const s of specs) {
        if (s.kind !== "assume") continue;
        const e = this.attempt(() => this.boolExpr(s.expr, scope));
        if (!e) continue;
        assumes.push(e);
        program.props.push({ kind: "assume", component: scope.label, desc: label(s), expr: e, loc: s.loc });
      }
      const hist = assumes.length ? this.historically(andAll(assumes), `${scope.prefix}assumptions_hold`) : null;
      // `historically` is valid exactly when the assumptions are; proving it alongside them
      // (hidden from the report) lets k-induction use the guarded guarantees.
      if (hist) program.props.push({ kind: "history", hidden: true, component: scope.label, desc: "assumptions have always held", expr: hist });
      for (const s of specs) {
        if (s.kind === "guarantee" || s.kind === "assert") {
          const e = this.attempt(() => this.boolExpr(s.expr, scope));
          if (!e) continue;
          program.asserts.push({ expr: hist && s.kind === "guarantee" ? N("=>", BOOL, hist, e) : e, label: `${scope.label} ${s.kind} ${label(s)}` });
        } else if (s.kind === "lemma") {
          program.warnings.push(`Lemma '${label(s)}' of ${scope.label} is checked when verifying ${scope.classifier.name}, not here`);
        }
      }
    }
    program.props.forEach((p, i) => {
      p.id = `p${i}`;
      p.name = p.component ? `${p.component}: ${p.kind} ${p.desc}` : `${p.kind} ${p.desc}`;
    });
    if (!program.props.length) program.warnings.push(`'${impl.name}' and its subcomponents have no AGREE guarantees, lemmas or assumptions to check`);
    return { program, errors: this.errors };
  }

  declareLocals(scope, specs) {
    for (const s of specs) {
      this.attempt(() => {
        if (s.kind === "eq") {
          for (const v of s.vars) {
            if (scope.names.has(lc(v.name))) throw new TranslationError(`'${v.name}' is already declared`, v.loc);
            const type = this.agreeType(v.type, s.owner.pkg);
            const name = scope.prefix + v.name;
            this.program.declare(name, type, { role: "eq", label: scope.prefix ? `${scope.label}.${v.name}` : v.name, scope: scope.label });
            scope.names.set(lc(v.name), { var: name, type });
          }
        } else if (s.kind === "property") {
          const name = scope.prefix + s.name;
          this.program.declare(name, BOOL, { role: "eq", label: scope.prefix ? `${scope.label}.${s.name}` : s.name, scope: scope.label });
          scope.names.set(lc(s.name), { var: name, type: BOOL });
        } else if (s.kind === "const") {
          scope.consts.set(lc(s.name), { ...s, pkg: s.owner.pkg });
        } else if (s.kind === "node" || s.kind === "fun") {
          scope.decls.set(lc(s.name), { ...s, pkg: s.owner.pkg });
        }
      });
    }
  }

  defineLocals(scope, specs) {
    for (const s of specs) {
      this.attempt(() => {
        if (s.kind === "eq" && s.expr) {
          if (s.vars.length > 1) {
            if (s.expr.k !== "call") throw new TranslationError("An eq with several variables must be defined by a node call", s.loc);
            const outs = this.callNode(s.expr, scope, true);
            if (outs.length !== s.vars.length) throw new TranslationError(`Node '${s.expr.name}' returns ${outs.length} values but ${s.vars.length} are expected`, s.loc);
            s.vars.forEach((v, i) => this.define(scope, v.name, outs[i], s.loc));
          } else {
            this.define(scope, s.vars[0].name, this.expr(s.expr, scope), s.loc);
          }
        } else if (s.kind === "property") {
          this.define(scope, s.name, this.expr(s.expr, scope), s.loc);
        }
      });
    }
  }

  define(scope, name, e, loc) {
    const entry = scope.names.get(lc(name));
    const v = this.program.vars.get(entry.var);
    const coerced = this.coerce(e, v.type, loc, `definition of '${name}'`);
    v.expr = coerced;
  }

  historically(e, base) {
    const name = `${base}${this.histCounter++ ? "_" + this.histCounter : ""}`;
    this.program.declare(name, BOOL, { role: "internal", label: name, visible: false });
    const v = this.program.vars.get(name);
    v.expr = N("and", BOOL, e, N("arrow", BOOL, L(BOOL, true), N("pre", BOOL, V(name, BOOL))));
    return V(name, BOOL);
  }

  // ---- expressions --------------------------------------------------------------

  coerce(e, type, loc, what) {
    if (e.type === type) return e;
    throw new TranslationError(`Type mismatch in ${what}: expected ${type} but found ${e.type}`, loc);
  }

  boolExpr(ast, scope) {
    return this.coerce(this.expr(ast, scope), BOOL, ast.loc, "contract");
  }

  lookupConst(name, scope) {
    const local = scope.consts.get(lc(name));
    if (local) return local;
    const d = this.library.get(lc(name));
    return d?.kind === "const" ? d : null;
  }

  lookupDecl(name, scope) {
    return scope.decls.get(lc(name)) || this.library.get(lc(name)) || null;
  }

  expr(ast, scope) {
    switch (ast.k) {
      case "int":
        return L(INT, ast.v);
      case "real":
        return L(REAL, ast.v);
      case "bool":
        return L(BOOL, ast.v);
      case "id":
        return this.ident(ast, scope);
      case "un": {
        const e = this.expr(ast.e, scope);
        if (ast.op === "not") return N("not", BOOL, this.coerce(e, BOOL, ast.loc, "'not'"));
        if (e.type === BOOL) throw new TranslationError("Unary '-' needs a numeric operand", ast.loc);
        return N("neg", e.type, e);
      }
      case "bin":
        return this.binary(ast, scope);
      case "arrow": {
        const a = this.expr(ast.l, scope);
        const b = this.expr(ast.r, scope);
        if (a.type !== b.type) throw new TranslationError(`'->' operands have different types (${a.type}, ${b.type})`, ast.loc);
        return N("arrow", a.type, a, b);
      }
      case "pre": {
        const e = this.expr(ast.e, scope);
        return N("pre", e.type, e);
      }
      case "prev": {
        const e = this.expr(ast.e, scope);
        const init = this.coerce(this.expr(ast.init, scope), e.type, ast.loc, "prev() initial value");
        return N("arrow", e.type, init, N("pre", e.type, e));
      }
      case "ite": {
        const c = this.coerce(this.expr(ast.c, scope), BOOL, ast.loc, "if condition");
        const a = this.expr(ast.t, scope);
        const b = this.expr(ast.e, scope);
        if (a.type !== b.type) throw new TranslationError(`if/then/else branches have different types (${a.type}, ${b.type})`, ast.loc);
        return N("ite", a.type, c, a, b);
      }
      case "cast": {
        const e = this.expr(ast.e, scope);
        if (ast.to === "real") return N("toReal", REAL, this.coerce(e, INT, ast.loc, "real()"));
        return N("floor", INT, this.coerce(e, REAL, ast.loc, "floor()"));
      }
      case "call": {
        const outs = this.callNode(ast, scope, false);
        if (outs.length !== 1) throw new TranslationError(`Node '${ast.name}' returns ${outs.length} values; use it in an eq with ${outs.length} variables`, ast.loc);
        return outs[0];
      }
      default:
        throw new TranslationError(`Unsupported expression '${ast.k}'`, ast.loc);
    }
  }

  binary(ast, scope) {
    const a = this.expr(ast.l, scope);
    const b = this.expr(ast.r, scope);
    const op = ast.op;
    if (["and", "or", "=>", "<=>"].includes(op)) {
      return N(op, BOOL, this.coerce(a, BOOL, ast.loc, `'${op}'`), this.coerce(b, BOOL, ast.loc, `'${op}'`));
    }
    if (a.type !== b.type) throw new TranslationError(`'${op}' operands have different types (${a.type}, ${b.type}); use real() or floor() to convert`, ast.loc);
    if (op === "=" || op === "<>") return N(op, BOOL, a, b);
    if (a.type === BOOL) throw new TranslationError(`'${op}' needs numeric operands`, ast.loc);
    if (["<", "<=", ">", ">="].includes(op)) return N(op, BOOL, a, b);
    if (op === "div" || op === "mod") {
      if (a.type !== INT) throw new TranslationError(`'${op}' needs integer operands`, ast.loc);
      return N(op, INT, a, b);
    }
    if (op === "/") return N(a.type === INT ? "div" : "/", a.type, a, b);
    return N(op, a.type, a, b);
  }

  ident(ast, scope) {
    const [head, ...rest] = ast.path;
    const show = ast.path.join(".");
    if (rest.length === 0) {
      const entry = scope.names.get(lc(head));
      if (entry?.unsupported) throw new TranslationError(`Cannot use '${head}' in AGREE: ${entry.unsupported}`, ast.loc);
      if (entry) return V(entry.var, entry.type);
      if (scope.locals?.has(lc(head))) return scope.locals.get(lc(head));
      const c = this.lookupConst(head, scope);
      if (c) return this.constValue(c, ast.loc);
      throw new TranslationError(`Unknown name '${head}' in ${scope.label || this.impl.name}`, ast.loc);
    }
    if (rest.length === 1) {
      const sub = scope.subs?.get(lc(head));
      if (sub) {
        const entry = sub.names.get(lc(rest[0]));
        if (entry?.unsupported) throw new TranslationError(`Cannot use '${show}' in AGREE: ${entry.unsupported}`, ast.loc);
        if (!entry) throw new TranslationError(`Subcomponent '${head}' has no port or eq '${rest[0]}'`, ast.loc);
        return V(entry.var, entry.type);
      }
      const c = this.lookupConst(`${head}::${rest[0]}`, scope);
      if (c) return this.constValue(c, ast.loc);
    }
    throw new TranslationError(`Unknown name '${show}'`, ast.loc);
  }

  constValue(c, loc) {
    if (c._resolving) throw new TranslationError(`Constant '${c.name}' is defined in terms of itself`, loc);
    c._resolving = true;
    try {
      const type = this.agreeType(c.type, c.pkg);
      const e = this.expr(c.expr, { names: new Map(), consts: new Map(), decls: new Map(), label: c.name, pkgName: c.pkg });
      return this.coerce(e, type, loc, `constant '${c.name}'`);
    } finally {
      c._resolving = false;
    }
  }

  /** Inline a fun (macro) or instantiate a node (fresh streams). Returns its outputs. */
  callNode(ast, scope, multi) {
    const decl = this.lookupDecl(ast.name, scope);
    if (!decl || (decl.kind !== "node" && decl.kind !== "fun")) throw new TranslationError(`Unknown node or function '${ast.name}'`, ast.loc);
    if (decl.params.length !== ast.args.length) throw new TranslationError(`'${decl.name}' expects ${decl.params.length} arguments but got ${ast.args.length}`, ast.loc);
    const args = ast.args.map((a, i) => this.coerce(this.expr(a, scope), this.agreeType(decl.params[i].type, decl.pkg), a.loc, `argument '${decl.params[i].name}' of '${decl.name}'`));
    const inner = { names: new Map(), consts: new Map(), decls: new Map(), locals: new Map(), label: decl.name, pkgName: decl.pkg };
    if (decl.kind === "fun") {
      decl.params.forEach((p, i) => inner.locals.set(lc(p.name), args[i]));
      const body = this.expr(decl.expr, inner);
      return [this.coerce(body, this.agreeType(decl.returnType, decl.pkg), ast.loc, `result of '${decl.name}'`)];
    }
    if (decl._active) throw new TranslationError(`Recursive node '${decl.name}' is not supported`, ast.loc);
    const prefix = `${decl.name}_${++this.nodeCounter}__`;
    const all = [...decl.params, ...decl.returns, ...decl.locals];
    for (const v of all) {
      const type = this.agreeType(v.type, decl.pkg);
      this.program.declare(prefix + v.name, type, { role: "internal", label: `${decl.name}#${this.nodeCounter}.${v.name}`, visible: false });
      inner.names.set(lc(v.name), { var: prefix + v.name, type });
    }
    decl.params.forEach((p, i) => {
      this.program.vars.get(prefix + p.name).expr = args[i];
    });
    decl._active = true;
    try {
      for (const eq of decl.equations) {
        if (eq.lhs.length !== 1) throw new TranslationError("Node equations with several targets are not supported yet", eq.loc);
        const target = inner.names.get(lc(eq.lhs[0]));
        if (!target) throw new TranslationError(`Unknown variable '${eq.lhs[0]}' in node '${decl.name}'`, eq.loc);
        const v = this.program.vars.get(target.var);
        v.expr = this.coerce(this.expr(eq.expr, inner), v.type, eq.loc, `equation for '${eq.lhs[0]}'`);
      }
      for (const a of decl.asserts || []) {
        this.program.asserts.push({ expr: this.coerce(this.expr(a, inner), BOOL, a.loc, "node assert"), label: `${decl.name} assert` });
      }
    } finally {
      decl._active = false;
    }
    for (const v of [...decl.returns, ...decl.locals]) {
      if (!this.program.vars.get(prefix + v.name).expr) throw new TranslationError(`Node '${decl.name}' does not define '${v.name}'`, decl.loc);
    }
    void multi;
    return decl.returns.map((r) => V(prefix + r.name, inner.names.get(lc(r.name)).type));
  }
}

/** Which implementations in an instance hierarchy have something to verify. */
export function verificationTargets(model, rootImpl, { allLayers }) {
  const targets = [];
  const seen = new Set();
  const visit = (impl) => {
    if (!impl || impl.kind !== "componentImpl" || seen.has(impl)) return;
    seen.add(impl);
    const subs = model.allSubcomponents(impl);
    if (subs.length || model.annexSubclauses(impl, "agree").length) targets.push(impl);
    if (allLayers) for (const s of subs) visit(s._classifier);
  };
  visit(rootImpl);
  return targets;
}
