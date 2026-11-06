// Parser for the Error Model Annex v2 (SAE AS5506/1A): error type libraries,
// error behavior state machines, and component subclauses (propagations,
// error flows, component and composite error behavior, EMV2 properties).

import { tokenize, TokenStream, ParseError, AADL_OPERATORS } from "../../core/lexer.js";
import { parsePropertyAssociationsFrom } from "../../core/aadl-parser.js";

export const EMV2_KEYWORDS = [
  "error", "types", "type", "set", "extends", "renames", "behavior", "events", "event", "recover", "repair", "states",
  "state", "initial", "transitions", "propagations", "propagation", "flows", "source", "sink", "path", "component",
  "composite", "end", "use", "mappings", "transformations", "equivalence", "not", "in", "out", "containment", "when",
  "if", "and", "or", "ormore", "orless", "others", "all", "noerror", "processor", "memory", "binding", "bindings",
  "connection", "detections", "mode", "properties", "applies", "to", "same", "point",
];

export function parseEmv2(text, ctx = {}) {
  const loc = ctx.loc || {};
  const file = loc.file;
  const diagnostics = [];
  const tokens = tokenize(text, {
    operators: AADL_OPERATORS,
    line: loc.line || 1,
    col: loc.col || 1,
    offset: loc.pos || 0,
    onError: (e) => diagnostics.push({ file, line: e.line, col: e.col, severity: "error", message: e.message }),
  });
  const p = new Emv2Parser(new TokenStream(tokens), file, diagnostics);
  const ast = ctx.kind === "library" ? p.parseLibrary() : p.parseSubclause();
  return { ast, diagnostics };
}

class Emv2Parser {
  constructor(ts, file, diagnostics) {
    this.ts = ts;
    this.file = file;
    this.diagnostics = diagnostics;
  }

  loc(t = this.ts.peek()) {
    return { file: this.file, line: t.line, col: t.col, pos: t.pos };
  }

  report(e) {
    const t = e.token || this.ts.peek();
    this.diagnostics.push({ file: this.file, line: t.line, col: t.col, severity: "error", message: e.message });
  }

  /** Run `fn`; on a parse error report it and skip past the next ';'. */
  recover(fn) {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.report(e);
      const ts = this.ts;
      while (!ts.atEnd() && !ts.isOp(";") && !ts.isKw("end")) ts.next();
      ts.acceptOp(";");
      return null;
    }
  }

  qname() {
    const ts = this.ts;
    let n = ts.expectId().value;
    while (ts.acceptOp("::")) n += "::" + ts.expectId().value;
    return n;
  }

  /** `{A, B * C, noerror}` → [{ types: ['A'] }, { types: ['B', 'C'] }, ...] */
  typeSet() {
    const ts = this.ts;
    ts.expectOp("{");
    const out = [];
    while (!ts.atEnd() && !ts.isOp("}")) {
      if (ts.acceptOp(",")) continue;
      const product = [this.qname()];
      while (ts.acceptOp("*")) product.push(this.qname());
      out.push({ types: product });
    }
    ts.expectOp("}");
    return out;
  }

  optTypeSet() {
    return this.ts.isOp("{") ? this.typeSet() : null;
  }

  endKw(word) {
    const ts = this.ts;
    ts.expectKw("end");
    ts.expectKw(word);
    ts.expectOp(";");
  }

  useClauses(target) {
    const ts = this.ts;
    while (ts.isKw("use")) {
      this.recover(() => {
        ts.next();
        if (ts.acceptKw("types")) {
          do target.useTypes.push(this.qname());
          while (ts.acceptOp(","));
        } else if (ts.acceptKw("behavior")) {
          target.useBehavior = this.qname();
        } else if (ts.acceptKw("type")) {
          ts.expectKw("equivalence");
          target.useTypeEquivalence = this.qname();
        } else if (ts.acceptKw("mappings") || ts.acceptKw("transformations")) {
          this.qname();
        } else throw new ParseError(`Unknown 'use' clause '${ts.peek().value}'`, ts.peek());
        ts.expectOp(";");
      });
    }
  }

  // ---- library -------------------------------------------------------------------------

  parseLibrary() {
    const ts = this.ts;
    const lib = { kind: "emv2Library", useTypes: [], types: [], typeSets: [], behaviors: [], extends: [] };
    while (!ts.atEnd()) {
      const t = ts.peek();
      if (ts.isKw("error") && ts.isKw("types", 1)) {
        this.recover(() => this.parseTypes(lib)) ;
      } else if (ts.isKw("error") && ts.isKw("behavior", 1)) {
        this.recover(() => lib.behaviors.push(this.parseBehavior()));
      } else if (ts.isKw("error") && ts.isKw("type", 1)) {
        // `error type mappings / transformations` — accepted and skipped
        while (!ts.atEnd() && !(ts.isKw("end") && (ts.isKw("mappings", 1) || ts.isKw("transformations", 1)))) ts.next();
        if (!ts.atEnd()) {
          ts.next();
          ts.next();
          ts.acceptOp(";");
        }
      } else {
        this.report(new ParseError(`Unexpected '${t.value}' in EMV2 library`, t));
        ts.next();
      }
    }
    return lib;
  }

  parseTypes(lib) {
    const ts = this.ts;
    ts.expectKw("error");
    ts.expectKw("types");
    if (ts.acceptKw("extends")) {
      do lib.extends.push(this.qname());
      while (ts.acceptOp(","));
      ts.expectKw("with");
    }
    this.useClauses(lib);
    while (!ts.atEnd() && !ts.isKw("end")) {
      if (ts.isKw("properties")) {
        ts.next();
        lib.properties = parsePropertyAssociationsFrom(ts, this.file, this.diagnostics);
        continue;
      }
      this.recover(() => {
        const nameTok = ts.expectId("error type name");
        if (ts.acceptKw("renames")) {
          ts.expectKw("type");
          const target = this.qname();
          ts.expectOp(";");
          lib.types.push({ name: nameTok.value, renames: target, loc: this.loc(nameTok) });
          return;
        }
        ts.expectOp(":");
        ts.expectKw("type");
        if (ts.acceptKw("set")) {
          const members = this.typeSet();
          ts.expectOp(";");
          lib.typeSets.push({ name: nameTok.value, members, loc: this.loc(nameTok) });
          return;
        }
        const decl = { name: nameTok.value, parent: null, loc: this.loc(nameTok) };
        if (ts.acceptKw("extends")) decl.parent = this.qname();
        ts.expectOp(";");
        lib.types.push(decl);
      });
    }
    this.endKw("types");
  }

  parseBehavior() {
    const ts = this.ts;
    ts.expectKw("error");
    ts.expectKw("behavior");
    const nameTok = ts.expectId("behavior name");
    const b = { kind: "behavior", name: nameTok.value, loc: this.loc(nameTok), useTypes: [], events: [], states: [], transitions: [] };
    this.useClauses(b);
    while (!ts.atEnd() && !ts.isKw("end")) {
      if (ts.acceptKw("events")) this.parseEvents(b.events);
      else if (ts.acceptKw("states")) this.parseStates(b.states);
      else if (ts.acceptKw("transitions")) this.parseTransitions(b.transitions);
      else if (ts.acceptKw("properties")) b.properties = parsePropertyAssociationsFrom(ts, this.file, this.diagnostics);
      else throw new ParseError(`Unexpected '${ts.peek().value}' in error behavior '${b.name}'`, ts.peek());
    }
    this.endKw("behavior");
    return b;
  }

  sectionDone() {
    const ts = this.ts;
    const t = ts.peek();
    return ts.atEnd() || t.type !== "id" || ["end", "events", "states", "transitions", "propagations", "detections", "flows", "properties", "mode"].includes(t.lower) && !ts.isOp(":", 1);
  }

  parseEvents(list) {
    const ts = this.ts;
    while (!this.sectionDone()) {
      this.recover(() => {
        const nameTok = ts.expectId("event name");
        ts.expectOp(":");
        const kind = ts.expectId("event kind").lower;
        if (!["error", "recover", "repair"].includes(kind)) throw new ParseError(`Unknown event kind '${kind}'`, nameTok);
        ts.expectKw("event");
        const ev = { name: nameTok.value, eventKind: kind, types: this.optTypeSet(), loc: this.loc(nameTok) };
        if (ts.acceptKw("if")) ts.next();
        ts.expectOp(";");
        list.push(ev);
      });
    }
  }

  parseStates(list) {
    const ts = this.ts;
    while (!this.sectionDone()) {
      this.recover(() => {
        const nameTok = ts.expectId("state name");
        ts.expectOp(":");
        const initial = !!ts.acceptKw("initial");
        ts.expectKw("state");
        list.push({ name: nameTok.value, initial, types: this.optTypeSet(), loc: this.loc(nameTok) });
        ts.expectOp(";");
      });
    }
  }

  stateRef() {
    const ts = this.ts;
    if (ts.acceptKw("all")) return { state: "all" };
    if (ts.acceptKw("same")) {
      ts.expectKw("state");
      return { state: "same" };
    }
    const t = ts.expectId("state");
    return { state: t.value, types: this.optTypeSet(), loc: this.loc(t) };
  }

  /** Condition expression inside `-[ ... ]->`. */
  condition() {
    return this.orExpr();
  }

  orExpr() {
    let l = this.andExpr();
    while (this.ts.acceptKw("or")) l = { op: "or", args: [l, this.andExpr()] };
    return l;
  }

  andExpr() {
    let l = this.unaryExpr();
    while (this.ts.acceptKw("and")) l = { op: "and", args: [l, this.unaryExpr()] };
    return l;
  }

  unaryExpr() {
    const ts = this.ts;
    if (ts.acceptKw("not")) return { op: "not", args: [this.unaryExpr()] };
    if (ts.acceptOp("(")) {
      const e = this.condition();
      ts.expectOp(")");
      return e;
    }
    if (ts.peek().type === "int") {
      const n = Number(ts.next().value);
      const op = ts.acceptKw("ormore") ? "ormore" : ts.acceptKw("orless") ? "orless" : null;
      if (!op) throw new ParseError("Expected 'ormore' or 'orless' after a count", ts.peek());
      ts.expectOp("(");
      const args = [];
      while (!ts.atEnd() && !ts.isOp(")")) {
        if (ts.acceptOp(",")) continue;
        args.push(this.condition());
      }
      ts.expectOp(")");
      return { op, count: n, args };
    }
    if (ts.acceptKw("others")) return { op: "others" };
    if (ts.acceptKw("all")) {
      if (ts.isOp("-") ) return { op: "all" };
      ts.expectOp("(");
      const args = [];
      while (!ts.atEnd() && !ts.isOp(")")) {
        if (ts.acceptOp(",")) continue;
        args.push(this.condition());
      }
      ts.expectOp(")");
      return { op: "and", args };
    }
    const t = ts.expectId("event, state or propagation point");
    const path = [t.value];
    while (ts.acceptOp(".")) path.push(ts.expectId().value);
    return { op: "ref", path, types: this.optTypeSet(), loc: this.loc(t) };
  }

  parseTransitions(list) {
    const ts = this.ts;
    while (!this.sectionDone() || ts.isKw("all") || ts.isOp("[")) {
      if (ts.peek().type !== "id" && !ts.isOp("[")) break;
      const r = this.recover(() => {
        let name = null;
        const start = ts.peek();
        if (ts.peek().type === "id" && ts.isOp(":", 1)) {
          name = ts.next().value;
          ts.next();
        }
        const src = this.stateRef();
        ts.expectOp("-");
        ts.expectOp("[");
        const cond = ts.isOp("]") ? null : this.condition();
        ts.expectOp("]");
        ts.expectOp("->");
        let dst;
        if (ts.acceptOp("(")) {
          // branching transition: (s1 with 0.9, s2 with others)
          dst = { branches: [] };
          while (!ts.atEnd() && !ts.isOp(")")) {
            if (ts.acceptOp(",")) continue;
            const ref = this.stateRef();
            ts.expectKw("with");
            const p = ts.peek().type === "id" ? ts.next().value : Number(ts.next().value);
            dst.branches.push({ ...ref, probability: p });
          }
          ts.expectOp(")");
        } else dst = this.stateRef();
        ts.expectOp(";");
        return { name, src, condition: cond, dst, loc: this.loc(start) };
      });
      if (r) list.push(r);
    }
  }

  // ---- subclause ---------------------------------------------------------------------------

  parseSubclause() {
    const ts = this.ts;
    const sc = {
      kind: "emv2Subclause", useTypes: [], useBehavior: null, propagations: [], flows: [], events: [], transitions: [],
      outgoing: [], detections: [], composite: [], properties: [],
    };
    this.useClauses(sc);
    while (!ts.atEnd()) {
      const t = ts.peek();
      if (ts.isKw("error") && ts.isKw("propagations", 1)) this.recover(() => this.parsePropagations(sc));
      else if (ts.isKw("component") && ts.isKw("error", 1)) this.recover(() => this.parseComponentBehavior(sc));
      else if (ts.isKw("composite") && ts.isKw("error", 1)) this.recover(() => this.parseComposite(sc));
      else if (ts.acceptKw("properties")) sc.properties.push(...parsePropertyAssociationsFrom(ts, this.file, this.diagnostics));
      else if (ts.isKw("use")) this.useClauses(sc);
      else {
        this.report(new ParseError(`Unexpected '${t.value}' in EMV2 subclause`, t));
        ts.next();
      }
    }
    return sc;
  }

  point() {
    const ts = this.ts;
    const t = ts.peek();
    if (ts.acceptKw("all")) return { path: ["all"], loc: this.loc(t) };
    const path = [ts.expectId("propagation point").value];
    while (ts.acceptOp(".")) path.push(ts.expectId().value);
    return { path, loc: this.loc(t) };
  }

  parsePropagations(sc) {
    const ts = this.ts;
    ts.expectKw("error");
    ts.expectKw("propagations");
    while (!ts.atEnd() && !ts.isKw("end") && !ts.isKw("flows")) {
      this.recover(() => {
        const pt = this.point();
        ts.expectOp(":");
        const not = !!ts.acceptKw("not");
        const direction = ts.acceptKw("in") ? "in" : ts.acceptKw("out") ? "out" : null;
        if (!direction) throw new ParseError("Expected 'in' or 'out'", ts.peek());
        const containment = !!ts.acceptKw("containment");
        if (!containment) ts.expectKw("propagation");
        sc.propagations.push({ point: pt.path.join("."), direction, not, containment, types: this.typeSet(), loc: pt.loc });
        ts.expectOp(";");
      });
    }
    if (ts.acceptKw("flows")) {
      while (!ts.atEnd() && !ts.isKw("end")) {
        this.recover(() => {
          const nameTok = ts.expectId("error flow name");
          ts.expectOp(":");
          ts.expectKw("error");
          const kind = ts.expectId("error flow kind").lower;
          const flow = { name: nameTok.value, flowKind: kind, loc: this.loc(nameTok) };
          if (kind === "source") {
            flow.out = this.point().path.join(".");
            flow.outTypes = this.optTypeSet();
            if (ts.acceptKw("when")) flow.when = ts.isOp("{") ? { types: this.typeSet() } : this.stateRef();
          } else if (kind === "sink") {
            flow.in = this.point().path.join(".");
            flow.inTypes = this.optTypeSet();
          } else if (kind === "path") {
            flow.in = this.point().path.join(".");
            flow.inTypes = this.optTypeSet();
            ts.expectOp("->");
            flow.out = this.point().path.join(".");
            flow.outTypes = this.optTypeSet();
            if (ts.acceptKw("use")) {
              ts.expectKw("mappings");
              flow.mappings = this.qname();
            }
          } else throw new ParseError(`Unknown error flow kind '${kind}'`, nameTok);
          if (ts.acceptKw("if")) ts.next();
          ts.expectOp(";");
          sc.flows.push(flow);
        });
      }
    }
    this.endKw("propagations");
  }

  parseComponentBehavior(sc) {
    const ts = this.ts;
    ts.expectKw("component");
    ts.expectKw("error");
    ts.expectKw("behavior");
    while (!ts.atEnd() && !ts.isKw("end")) {
      if (ts.isKw("use")) this.useClauses(sc);
      else if (ts.acceptKw("events")) this.parseEvents(sc.events);
      else if (ts.acceptKw("transitions")) this.parseTransitions(sc.transitions);
      else if (ts.acceptKw("propagations")) {
        while (!this.sectionDone() || ts.isKw("all")) {
          if (ts.peek().type !== "id") break;
          const r = this.recover(() => {
            let name = null;
            const start = ts.peek();
            if (ts.isOp(":", 1)) {
              name = ts.next().value;
              ts.next();
            }
            const src = this.stateRef();
            ts.expectOp("-");
            ts.expectOp("[");
            const cond = ts.isOp("]") ? null : this.condition();
            ts.expectOp("]");
            ts.expectOp("->");
            const pt = this.point();
            const types = this.optTypeSet();
            ts.expectOp(";");
            return { name, src, condition: cond, point: pt.path.join("."), types, loc: this.loc(start) };
          });
          if (r) sc.outgoing.push(r);
        }
      } else if (ts.acceptKw("detections") || (ts.isKw("mode") && ts.isKw("mappings", 1) && (ts.next(), ts.next()))) {
        while (!this.sectionDone()) {
          const start = ts.peek();
          while (!ts.atEnd() && !ts.isOp(";")) ts.next();
          ts.acceptOp(";");
          sc.detections.push({ loc: this.loc(start) });
        }
      } else throw new ParseError(`Unexpected '${ts.peek().value}' in component error behavior`, ts.peek());
    }
    this.endKw("component");
  }

  parseComposite(sc) {
    const ts = this.ts;
    ts.expectKw("composite");
    ts.expectKw("error");
    ts.expectKw("behavior");
    if (ts.isKw("use")) this.useClauses(sc);
    ts.expectKw("states");
    while (!ts.atEnd() && !ts.isKw("end")) {
      const r = this.recover(() => {
        let name = null;
        const start = ts.peek();
        if (ts.peek().type === "id" && ts.isOp(":", 1)) {
          name = ts.next().value;
          ts.next();
        }
        ts.expectOp("[");
        const cond = this.condition();
        ts.expectOp("]");
        ts.expectOp("->");
        const dst = this.stateRef();
        ts.expectOp(";");
        return { name, condition: cond, dst, loc: this.loc(start) };
      });
      if (r) sc.composite.push(r);
    }
    this.endKw("composite");
  }
}
