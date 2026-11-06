// Resolute evaluation over the instance model. Claim functions produce an
// assurance-case tree: each claim invocation becomes a node whose children
// are the claims it relied on.

import { instanceProperty, connectionProperty } from "../../core/instance.js";
import { toBase, formatValue } from "../../core/properties.js";

const lc = (s) => (s || "").toLowerCase();
const CATEGORIES = ["system", "process", "thread", "thread group", "processor", "virtual processor", "memory", "bus", "virtual bus", "device", "data", "subprogram", "subprogram group", "abstract"];

export class ResoluteError extends Error {
  constructor(message, loc) {
    super(message);
    this.loc = loc;
  }
}

const UNIT_KIND = (u) => {
  const x = lc(u);
  if (["ps", "ns", "us", "ms", "sec", "min", "hr"].includes(x)) return "time";
  if (["bits", "bytes", "kbyte", "mbyte", "gbyte", "tbyte"].includes(x)) return "size";
  if (/ps$/.test(x)) return "dataRate";
  if (["g", "kg", "t"].includes(x)) return "mass";
  if (["mw", "w", "kw"].includes(x)) return "power";
  if (/hz$/.test(x)) return "frequency";
  if (/ips$/.test(x)) return "mips";
  return null;
};
const MIPS = { kips: 1e-3, mips: 1, gips: 1e3 };

function numberValue(v) {
  if (v.unit) {
    const kind = UNIT_KIND(v.unit);
    if (kind === "mips") return v.value * MIPS[lc(v.unit)];
    const b = kind && toBase({ type: "number", value: v.value, unit: v.unit }, kind);
    return b ?? v.value;
  }
  return v.value;
}

const display = (v) => {
  if (v === null || v === undefined) return "?";
  if (Array.isArray(v)) return `{${v.map(display).join(", ")}}`;
  if (typeof v === "object") {
    if (v.qualifiedPath !== undefined) return v.parent ? v.qualifiedPath : v.name;
    if (v.kind === "connection") return v.conn.name;
    if (v.kind === "feature") return `${v.owner.parent ? v.owner.qualifiedPath + "." : ""}${v.feature.name}`;
    if (v.min !== undefined) return `${v.min} .. ${v.max}`;
  }
  return String(v);
};

export class Resolute {
  constructor(model, root) {
    this.model = model;
    this.root = root;
    this.defs = new Map();
    for (const { annex } of model.annexLibraries("resolute")) for (const d of annex.parsed?.definitions || []) this.defs.set(lc(d.name), d);
    for (const inst of root.walk()) {
      for (const { annex } of model.annexSubclauses(inst.classifier, "resolute")) for (const d of annex.parsed?.definitions || []) this.defs.set(lc(d.name), d);
    }
    this.stack = [];
    this.constCache = new Map();
  }

  allComponents() {
    return [...this.root.walk()];
  }

  allConnections() {
    return this.allComponents().flatMap((owner) => owner.connections.map((conn) => ({ kind: "connection", conn, owner })));
  }

  allFeatures() {
    return this.allComponents().flatMap((owner) => owner.features.map((feature) => ({ kind: "feature", feature, owner })));
  }

  domainOf(domain, env) {
    if (domain.kind === "type") return this.typeDomain(domain.name);
    const v = this.eval(domain.expr, env);
    if (!Array.isArray(v)) throw new ResoluteError("quantifier domain is not a set", domain.expr.loc);
    return v;
  }

  typeDomain(name) {
    const n = lc(name);
    if (n === "component" || n === "aadl") return this.allComponents();
    if (CATEGORIES.includes(n)) return this.allComponents().filter((c) => c.category === n);
    if (n === "connection") return this.allConnections();
    if (n === "feature") return this.allFeatures();
    if (n === "port") return this.allFeatures().filter((f) => /port/.test(f.feature.kind || ""));
    throw new ResoluteError(`Unknown quantifier type '${name}'`);
  }

  property(x, name, def) {
    let v = null;
    if (x?.qualifiedPath !== undefined) v = instanceProperty(this.model, x, name);
    else if (x?.kind === "connection") v = connectionProperty(this.model, x.owner, x.conn, name);
    else if (x?.kind === "feature") v = instanceProperty(this.model, x.owner, name, x.feature.name);
    if (!v) {
      if (def !== undefined) return def;
      throw new ResoluteError(`${display(x)} has no property ${name}`);
    }
    return this.convert(v, x);
  }

  convert(v, ctx) {
    switch (v.type) {
      case "number": return numberValue(v);
      case "range": return { min: this.convert(v.min, ctx), max: this.convert(v.max, ctx) };
      case "string": return v.value;
      case "bool": return v.value;
      case "name": return v.name;
      case "list": return v.items.map((i) => this.convert(i, ctx));
      case "reference": {
        let cur = this.root;
        for (const part of v.path.split(".")) cur = cur?.child(part);
        return cur || v.path;
      }
      case "classifier": return v.name;
      default: return formatValue(v);
    }
  }

  componentOf(x) {
    if (x?.qualifiedPath !== undefined) return x;
    if (x?.kind === "feature") return x.owner;
    if (x?.kind === "connection") return x.owner;
    return null;
  }

  builtin(name, args, loc) {
    const a = args;
    const comp = (v) => {
      const c = this.componentOf(v);
      if (!c) throw new ResoluteError(`${name}: expected a component`, loc);
      return c;
    };
    switch (lc(name)) {
      case "has_property": return a[0] !== null && this.property(a[0], a[1], null) !== null;
      case "property": return this.property(a[0], a[1], a.length > 2 ? a[2] : undefined);
      case "subcomponents": return [...comp(a[0]).children];
      case "features": return comp(a[0]).features.map((feature) => ({ kind: "feature", feature, owner: comp(a[0]) }));
      case "connections": return comp(a[0]).connections.map((conn) => ({ kind: "connection", conn, owner: comp(a[0]) }));
      case "source": return a[0].conn.src.component === a[0].owner ? a[0].owner : a[0].conn.src.component;
      case "destination": return a[0].conn.dst.component === a[0].owner ? a[0].owner : a[0].conn.dst.component;
      case "source_feature": return { kind: "feature", feature: a[0].conn.src.feature, owner: a[0].conn.src.component };
      case "destination_feature": return { kind: "feature", feature: a[0].conn.dst.feature, owner: a[0].conn.dst.component };
      case "parent": return comp(a[0]).parent || null;
      case "name": return a[0]?.qualifiedPath !== undefined ? a[0].name : a[0]?.kind === "feature" ? a[0].feature.name : a[0]?.kind === "connection" ? a[0].conn.name : String(a[0]);
      case "type": return a[0]?.qualifiedPath !== undefined ? (a[0].classifier ? `${a[0].classifier.pkg}::${a[0].classifier.name}` : null) : a[0]?.feature?.decl?.classifier?.name || null;
      case "has_type": return !!this.builtin("type", a, loc);
      case "category": return comp(a[0]).category;
      case "is_thread": case "is_process": case "is_system": case "is_processor": case "is_device": case "is_memory": case "is_bus": case "is_data":
        return comp(a[0]).category === lc(name).slice(3);
      case "is_port": return a[0]?.kind === "feature" && /port/.test(a[0].feature.kind || "");
      case "direction": return a[0]?.feature?.direction || null;
      case "contained": {
        let c = comp(a[0]);
        for (; c; c = c.parent) if (c === a[1]) return true;
        return false;
      }
      case "is_bound_to": {
        const b = this.property(a[0], "Actual_Processor_Binding", []);
        const list = Array.isArray(b) ? b : [b];
        return list.includes(a[1]);
      }
      case "bound": case "processor_binding": {
        const b = this.property(a[0], "Actual_Processor_Binding", []);
        return Array.isArray(b) ? b[0] ?? null : b;
      }
      case "size": case "length": return Array.isArray(a[0]) ? a[0].length : String(a[0]).length;
      case "sum": return a[0].reduce((s, x) => s + Number(x || 0), 0);
      case "max": return a[0].length ? Math.max(...a[0]) : 0;
      case "min": return a[0].length ? Math.min(...a[0]) : 0;
      case "member": return a[1].includes(a[0]);
      case "union": return [...new Set([...a[0], ...a[1]])];
      case "intersect": return a[0].filter((x) => a[1].includes(x));
      case "is_empty": return a[0].length === 0;
      case "upper_bound": return a[0]?.max ?? a[0];
      case "lower_bound": return a[0]?.min ?? a[0];
      case "debug": return a[0];
      case "analysis": throw new ResoluteError(`analysis(${display(a[0])}) is not available in the browser`, loc);
      default: return undefined;
    }
  }

  /** Evaluate a claim or function call; claims push a node onto the current tree. */
  call(name, args, loc) {
    const def = this.defs.get(lc(name));
    if (!def) {
      const r = this.builtin(name, args, loc);
      if (r === undefined) throw new ResoluteError(`Unknown function or claim '${name}'`, loc);
      return r;
    }
    if (def.params.length !== args.length) throw new ResoluteError(`'${def.name}' expects ${def.params.length} argument(s)`, loc);
    const env = new Map(def.params.map((p, i) => [lc(p.name), args[i]]));
    if (def.kind !== "claim") return this.eval(def.body, env);
    const node = {
      claim: def.name,
      text: def.text.map((t) => (t.str !== undefined ? t.str : display(env.has(lc(t.ref)) ? env.get(lc(t.ref)) : t.ref))).join(""),
      children: [],
      result: false,
      loc: def.loc,
    };
    this.stack.at(-1)?.children.push(node);
    if (this.stack.length > 64) throw new ResoluteError(`Claim recursion is too deep at '${def.name}'`, loc);
    this.stack.push(node);
    try {
      node.result = this.truth(this.eval(def.body, env), def.body.loc);
    } catch (e) {
      if (!(e instanceof ResoluteError)) throw e;
      node.result = false;
      node.error = e.message;
    } finally {
      this.stack.pop();
    }
    return node.result;
  }

  truth(v, loc) {
    if (typeof v !== "boolean") throw new ResoluteError(`Expected a boolean but found ${display(v)}`, loc);
    return v;
  }

  eval(e, env) {
    switch (e.kind) {
      case "lit":
        return typeof e.value === "number" ? numberValue(e) : e.value;
      case "id": {
        const n = lc(e.name);
        if (n === "this") return env.get("this");
        if (env.has(n)) return env.get(n);
        const def = this.defs.get(n);
        if (def?.kind === "constant") {
          if (!this.constCache.has(n)) this.constCache.set(n, this.eval(def.body, new Map()));
          return this.constCache.get(n);
        }
        if (def?.kind === "claim" && !def.params.length) return this.call(e.name, [], e.loc);
        // Property names (Timing_Properties::Period, Period) evaluate to themselves.
        if (e.name.includes("::") || this.model.propertyDefinition(e.name)) return e.name;
        throw new ResoluteError(`Unknown name '${e.name}'`, e.loc);
      }
      case "un": {
        const v = this.eval(e.e, env);
        return e.op === "not" ? !this.truth(v, e.loc) : -v;
      }
      case "bin": {
        if (e.op === "and") {
          const a = this.truth(this.eval(e.l, env), e.l.loc);
          const b = this.truth(this.eval(e.r, env), e.r.loc); // evaluated for a complete claim tree
          return a && b;
        }
        if (e.op === "or") {
          const a = this.truth(this.eval(e.l, env), e.l.loc);
          return a || this.truth(this.eval(e.r, env), e.r.loc);
        }
        if (e.op === "=>") {
          const a = this.truth(this.eval(e.l, env), e.l.loc);
          return !a || this.truth(this.eval(e.r, env), e.r.loc);
        }
        const a = this.eval(e.l, env), b = this.eval(e.r, env);
        switch (e.op) {
          case "=": return a === b || (typeof a === "string" && typeof b === "string" && lc(a) === lc(b));
          case "<>": return !(a === b);
          case "<": return a < b;
          case "<=": return a <= b;
          case ">": return a > b;
          case ">=": return a >= b;
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return a / b;
          case "%": return a % b;
          default: throw new ResoluteError(`Unknown operator ${e.op}`, e.loc);
        }
      }
      case "if":
        return this.truth(this.eval(e.c, env), e.loc) ? this.eval(e.a, env) : this.eval(e.b, env);
      case "let":
        return this.eval(e.body, new Map(env).set(lc(e.name), this.eval(e.value, env)));
      case "set":
        return e.items.map((i) => this.eval(i, env));
      case "comprehension": {
        const out = [];
        this.iterate(e.bindings, env, (inner) => {
          if (!e.cond || this.truth(this.eval(e.cond, inner), e.loc)) out.push(this.eval(e.expr, inner));
        });
        return [...new Set(out)];
      }
      case "quant": {
        let result = e.quant === "forall";
        this.iterate(e.bindings, env, (inner) => {
          const v = this.truth(this.eval(e.body, inner), e.loc);
          if (e.quant === "forall") result = result && v;
          else result = result || v;
        });
        return result;
      }
      case "call":
        return this.call(e.name, e.args.map((a) => this.eval(a, env)), e.loc);
      default:
        throw new ResoluteError(`Unsupported expression '${e.kind}'`, e.loc);
    }
  }

  iterate(bindings, env, fn, k = 0) {
    if (k === bindings.length) return fn(env);
    const b = bindings[k];
    for (const v of this.domainOf(b.domain, env)) this.iterate(bindings, new Map(env).set(lc(b.name), v), fn, k + 1);
  }

  /** Evaluate every prove statement in the instance hierarchy. */
  proveAll() {
    const results = [];
    for (const inst of this.root.walk()) {
      for (const { annex } of this.model.annexSubclauses(inst.classifier, "resolute")) {
        for (const p of annex.parsed?.proves || []) {
          const top = { claim: "prove", text: `prove ${p.call.name}(…) for ${inst.parent ? inst.qualifiedPath : inst.name}`, children: [], result: false, loc: p.loc, inst };
          this.stack = [top];
          try {
            const env = new Map([["this", inst]]);
            top.result = this.truth(this.call(p.call.name, p.call.args.map((a) => this.eval(a, env)), p.loc), p.loc);
          } catch (e) {
            if (!(e instanceof ResoluteError)) throw e;
            top.error = e.message;
          }
          this.stack = [];
          results.push(top.children.length === 1 && !top.error ? { ...top.children[0], inst, loc: top.children[0].loc } : top);
        }
      }
    }
    return results;
  }
}

export { display };
