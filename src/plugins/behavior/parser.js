// Parser for the AADL Behavior Annex (SAE AS5506/2) and the BLESS annex
// subset that shares its state-machine syntax. BLESS assertions (<< ... >>)
// and invariants are kept as text.

import { tokenize, TokenStream, ParseError } from "../../core/lexer.js";

const BA_OPERATORS = [
  "<<", ">>", "-[", "]->", ":=", "!=", "<=", ">=", "**", "::", "..", "!<", "!>", "->", "'", "!", "?", "=", "<", ">", "+", "-", "*", "/",
  "(", ")", "[", "]", "{", "}", ";", ":", ",", ".", "&", "|", "@", "^", "~", "#", "$",
];

export const BEHAVIOR_KEYWORDS = [
  "variables", "states", "transitions", "initial", "complete", "final", "state", "on", "dispatch", "timeout", "otherwise",
  "if", "elsif", "else", "end", "while", "for", "forall", "in", "do", "until", "computation", "and", "or", "xor", "not",
  "mod", "rem", "abs", "true", "false", "frozen", "stop", "skip", "invariant", "assert", "pre", "post", "exists",
];

export function parseBehavior(text, ctx = {}, { bless = false } = {}) {
  const loc = ctx.loc || {};
  const file = loc.file;
  const diagnostics = [];
  const tokens = tokenize(text, {
    operators: BA_OPERATORS,
    line: loc.line || 1,
    col: loc.col || 1,
    offset: loc.pos || 0,
    onError: (e) => diagnostics.push({ file, line: e.line, col: e.col, severity: "error", message: e.message }),
  });
  const p = new BehaviorParser(new TokenStream(tokens), file, diagnostics, bless, text, loc.pos || 0);
  return { ast: p.parse(), diagnostics };
}

class BehaviorParser {
  constructor(ts, file, diagnostics, bless, text, base) {
    this.ts = ts;
    this.file = file;
    this.diagnostics = diagnostics;
    this.bless = bless;
    this.text = text;
    this.base = base;
  }

  loc(t = this.ts.peek()) {
    return { file: this.file, line: t.line, col: t.col, pos: t.pos };
  }

  report(e) {
    const t = e.token || this.ts.peek();
    this.diagnostics.push({ file: this.file, line: t.line, col: t.col, severity: "error", message: e.message });
  }

  recover(fn) {
    try {
      return fn();
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.report(e);
      const ts = this.ts;
      let depth = 0;
      while (!ts.atEnd()) {
        if (ts.isOp("{")) depth++;
        if (ts.isOp("}")) depth--;
        if (depth <= 0 && ts.isOp(";")) break;
        if (depth <= 0 && ts.peek().type === "id" && ["states", "transitions", "variables"].includes(ts.peek().lower)) return null;
        ts.next();
      }
      ts.acceptOp(";");
      return null;
    }
  }

  /** BLESS assertion `<< ... >>` kept as raw text. */
  assertion() {
    const ts = this.ts;
    const start = ts.expectOp("<<");
    let depth = 1;
    let end = start;
    while (!ts.atEnd() && depth > 0) {
      const t = ts.next();
      if (t.type === "op" && t.value === "<<") depth++;
      if (t.type === "op" && t.value === ">>") depth--;
      end = t;
    }
    return { text: this.text.slice(start.end - this.base, end.pos - this.base).trim(), loc: this.loc(start) };
  }

  parse() {
    const ts = this.ts;
    const ba = { kind: this.bless ? "bless" : "behavior", variables: [], states: [], transitions: [], assertions: [], invariant: null };
    while (!ts.atEnd()) {
      const t = ts.peek();
      if (ts.acceptKw("variables")) this.parseVariables(ba);
      else if (ts.acceptKw("states")) this.parseStates(ba);
      else if (ts.acceptKw("transitions")) this.parseTransitions(ba);
      else if (this.bless && ts.acceptKw("invariant")) ba.invariant = this.assertion();
      else if (this.bless && ts.acceptKw("assert")) {
        while (ts.isOp("<<")) ba.assertions.push(this.assertion());
      } else {
        this.report(new ParseError(`Unexpected '${t.value}' in ${this.bless ? "BLESS" : "behavior"} annex`, t));
        ts.next();
      }
    }
    return ba;
  }

  atSection() {
    const t = this.ts.peek();
    return this.ts.atEnd() || (t.type === "id" && ["variables", "states", "transitions", "invariant", "assert"].includes(t.lower) && !this.ts.isOp(":", 1));
  }

  qname() {
    const ts = this.ts;
    let n = ts.expectId().value;
    while (ts.acceptOp("::")) n += "::" + ts.expectId().value;
    if (ts.isOp(".") && ts.peek(1).type === "id") {
      ts.next();
      n += "." + ts.next().value;
    }
    return n;
  }

  parseVariables(ba) {
    const ts = this.ts;
    while (!this.atSection()) {
      this.recover(() => {
        const names = [ts.expectId("variable name")];
        while (ts.acceptOp(",")) names.push(ts.expectId("variable name"));
        ts.expectOp(":");
        const type = this.qname();
        let init = null;
        if (ts.acceptOp(":=")) init = this.expr();
        if (this.bless && ts.isOp("<<")) this.assertion();
        ts.expectOp(";");
        for (const n of names) ba.variables.push({ name: n.value, type, init, loc: this.loc(n) });
      });
    }
  }

  parseStates(ba) {
    const ts = this.ts;
    while (!this.atSection()) {
      this.recover(() => {
        const names = [ts.expectId("state name")];
        while (ts.acceptOp(",")) names.push(ts.expectId("state name"));
        ts.expectOp(":");
        const flags = { initial: false, complete: false, final: false };
        for (;;) {
          if (ts.acceptKw("initial")) flags.initial = true;
          else if (ts.acceptKw("complete")) flags.complete = true;
          else if (ts.acceptKw("final")) flags.final = true;
          else if (ts.acceptKw("execute") || ts.acceptKw("exit")) continue;
          else break;
        }
        ts.expectKw("state");
        let assertion = null;
        if (this.bless && ts.isOp("<<")) assertion = this.assertion();
        ts.expectOp(";");
        for (const n of names) ba.states.push({ name: n.value, ...flags, assertion, loc: this.loc(n) });
      });
    }
  }

  parseTransitions(ba) {
    const ts = this.ts;
    while (!this.atSection()) {
      const t = this.recover(() => {
        const start = ts.peek();
        let name = null, priority = null;
        if (ts.peek().type === "id" && (ts.isOp(":", 1) || ts.isOp("[", 1))) {
          name = ts.next().value;
          if (ts.acceptOp("[")) {
            priority = Number(ts.next().value);
            ts.expectOp("]");
          }
          ts.expectOp(":");
        }
        const sources = [ts.expectId("source state").value];
        while (ts.acceptOp(",")) sources.push(ts.expectId("source state").value);
        ts.expectOp("-[");
        const guard = this.guard();
        ts.expectOp("]->");
        const dst = ts.expectId("destination state").value;
        let actions = null;
        if (ts.isOp("{")) actions = this.actionBlock();
        if (this.bless && ts.isOp("<<")) this.assertion();
        ts.expectOp(";");
        return { name, priority, sources, guard, dst, actions, loc: this.loc(start) };
      });
      if (t) ba.transitions.push(t);
    }
  }

  guard() {
    const ts = this.ts;
    if (ts.isOp("]->")) return { kind: "none" };
    if (ts.acceptKw("on")) {
      ts.expectKw("dispatch");
      const g = { kind: "dispatch", triggers: [], frozen: [] };
      if (ts.acceptKw("timeout")) {
        g.timeout = this.expr();
        return g;
      }
      while (ts.peek().type === "id" && !ts.isKw("frozen") && !ts.isOp("]->", 0)) {
        const p = [ts.next().value];
        while (ts.acceptOp(".")) p.push(ts.expectId().value);
        g.triggers.push(p.join("."));
        if (!ts.acceptKw("or") && !ts.acceptKw("and")) break;
      }
      if (ts.acceptKw("frozen")) {
        ts.expectOp("(");
        while (!ts.atEnd() && !ts.isOp(")")) ts.next();
        ts.expectOp(")");
      }
      return g;
    }
    if (ts.acceptKw("otherwise")) return { kind: "otherwise" };
    if (ts.acceptKw("timeout")) return { kind: "timeout", value: ts.isOp("]->") ? null : this.expr() };
    return { kind: "condition", expr: this.expr() };
  }

  // ---- actions ------------------------------------------------------------------------------

  actionBlock() {
    const ts = this.ts;
    ts.expectOp("{");
    const acts = this.actions(["}"]);
    ts.expectOp("}");
    return acts;
  }

  /** Action sequence separated by ';' (sequence) or '&' (set), up to a closing token. */
  actions(closers) {
    const ts = this.ts;
    const out = [];
    const closing = () => closers.some((c) => (c === "}" || c === ")" ? ts.isOp(c) : ts.isKw(c)));
    while (!ts.atEnd() && !closing()) {
      out.push(this.action());
      if (!ts.acceptOp(";") && !ts.acceptOp("&")) break;
    }
    return out;
  }

  action() {
    const ts = this.ts;
    const t = ts.peek();
    const loc = this.loc(t);
    if (ts.isOp("{")) return { kind: "block", body: this.actionBlock(), loc };
    if (ts.acceptKw("skip")) return { kind: "skip", loc };
    if (ts.acceptKw("if")) {
      const branches = [];
      ts.expectOp("(");
      const c = this.expr();
      ts.expectOp(")");
      branches.push({ cond: c, body: this.actions(["elsif", "else", "end"]) });
      let otherwise = null;
      for (;;) {
        if (ts.acceptKw("elsif")) {
          ts.expectOp("(");
          const c2 = this.expr();
          ts.expectOp(")");
          branches.push({ cond: c2, body: this.actions(["elsif", "else", "end"]) });
        } else if (ts.acceptKw("else")) {
          otherwise = this.actions(["end"]);
        } else break;
      }
      ts.expectKw("end");
      ts.expectKw("if");
      return { kind: "if", branches, otherwise, loc };
    }
    if (ts.acceptKw("while")) {
      ts.expectOp("(");
      const c = this.expr();
      ts.expectOp(")");
      return { kind: "while", cond: c, body: this.actionBlock(), loc };
    }
    if (ts.acceptKw("do")) {
      const body = this.actions(["until"]);
      ts.expectKw("until");
      ts.expectOp("(");
      const c = this.expr();
      ts.expectOp(")");
      return { kind: "while", cond: c, body, doUntil: true, loc };
    }
    if (ts.isKw("for") || ts.isKw("forall")) {
      ts.next();
      ts.expectOp("(");
      const v = ts.expectId("loop variable").value;
      ts.expectOp(":");
      const type = this.qname();
      ts.expectKw("in");
      const from = this.expr();
      let to = null;
      if (ts.acceptOp("..")) to = this.expr();
      ts.expectOp(")");
      return { kind: "for", variable: v, type, from, to, body: this.actionBlock(), loc };
    }
    if (ts.acceptKw("computation")) {
      ts.expectOp("(");
      const a = this.expr();
      let b = null;
      if (ts.acceptOp("..")) b = this.expr();
      ts.expectOp(")");
      return { kind: "computation", min: a, max: b, loc };
    }
    // Target: name(.name)* possibly followed by := , ! , ?, or a call `S!(args)`.
    const target = this.ref();
    if (ts.acceptOp(":=")) return { kind: "assign", target, value: this.expr(), loc };
    if (ts.acceptOp("!")) {
      const args = [];
      if (ts.acceptOp("(")) {
        while (!ts.atEnd() && !ts.isOp(")")) {
          if (ts.acceptOp(",")) continue;
          args.push(this.expr());
        }
        ts.expectOp(")");
      }
      return { kind: "send", target, args, loc };
    }
    if (ts.acceptOp("?")) {
      let into = null;
      if (ts.acceptOp("(")) {
        into = this.ref();
        ts.expectOp(")");
      }
      return { kind: "receive", target, into, loc };
    }
    if (ts.acceptOp(">>") || ts.acceptOp("!<") || ts.acceptOp("!>")) return { kind: "lock", target, loc };
    throw new ParseError(`Expected ':=', '!' or '?' after '${target.path.join(".")}'`, ts.peek());
  }

  ref() {
    const ts = this.ts;
    const t = ts.expectId("name");
    const path = [t.value];
    while (ts.acceptOp("::")) path[path.length - 1] += "::" + ts.expectId().value;
    while (ts.isOp(".") && ts.peek(1).type === "id") {
      ts.next();
      path.push(ts.next().value);
    }
    let index = null;
    if (ts.acceptOp("[")) {
      index = this.expr();
      ts.expectOp("]");
    }
    let attribute = null;
    if (ts.acceptOp("'")) attribute = ts.expectId("attribute").lower;
    return { kind: "ref", path, index, attribute, loc: this.loc(t) };
  }

  // ---- expressions ---------------------------------------------------------------------------

  expr() {
    let l = this.andExpr();
    for (;;) {
      if (this.ts.acceptKw("or")) l = { kind: "bin", op: "or", l, r: this.andExpr() };
      else if (this.ts.acceptKw("xor")) l = { kind: "bin", op: "xor", l, r: this.andExpr() };
      else return l;
    }
  }

  andExpr() {
    let l = this.relExpr();
    while (this.ts.acceptKw("and")) l = { kind: "bin", op: "and", l, r: this.relExpr() };
    return l;
  }

  relExpr() {
    const l = this.addExpr();
    for (const op of ["=", "!=", "<", "<=", ">", ">="]) {
      if (this.ts.acceptOp(op)) return { kind: "bin", op, l, r: this.addExpr() };
    }
    return l;
  }

  addExpr() {
    let l = this.mulExpr();
    for (;;) {
      if (this.ts.acceptOp("+")) l = { kind: "bin", op: "+", l, r: this.mulExpr() };
      else if (this.ts.acceptOp("-")) l = { kind: "bin", op: "-", l, r: this.mulExpr() };
      else return l;
    }
  }

  mulExpr() {
    let l = this.unary();
    for (;;) {
      if (this.ts.acceptOp("*")) l = { kind: "bin", op: "*", l, r: this.unary() };
      else if (this.ts.acceptOp("/")) l = { kind: "bin", op: "/", l, r: this.unary() };
      else if (this.ts.acceptKw("mod")) l = { kind: "bin", op: "mod", l, r: this.unary() };
      else if (this.ts.acceptKw("rem")) l = { kind: "bin", op: "rem", l, r: this.unary() };
      else if (this.ts.acceptOp("**")) l = { kind: "bin", op: "**", l, r: this.unary() };
      else return l;
    }
  }

  unary() {
    const ts = this.ts;
    const t = ts.peek();
    if (ts.acceptKw("not")) return { kind: "un", op: "not", e: this.unary(), loc: this.loc(t) };
    if (ts.acceptOp("-")) return { kind: "un", op: "-", e: this.unary(), loc: this.loc(t) };
    if (ts.acceptKw("abs")) return { kind: "un", op: "abs", e: this.unary(), loc: this.loc(t) };
    return this.primary();
  }

  primary() {
    const ts = this.ts;
    const t = ts.peek();
    const loc = this.loc(t);
    if (t.type === "int") {
      ts.next();
      return { kind: "lit", type: "int", value: Number(t.value), unit: this.unit(), loc };
    }
    if (t.type === "real") {
      ts.next();
      return { kind: "lit", type: "real", value: Number(t.value), unit: this.unit(), loc };
    }
    if (t.type === "string") {
      ts.next();
      return { kind: "lit", type: "string", value: t.value, loc };
    }
    if (ts.acceptOp("(")) {
      const e = this.expr();
      ts.expectOp(")");
      return e;
    }
    if (ts.isKw("true") || ts.isKw("false")) {
      ts.next();
      return { kind: "lit", type: "bool", value: t.lower === "true", loc };
    }
    if (this.bless && ts.isKw("now")) {
      ts.next();
      return { kind: "lit", type: "real", value: 0, loc };
    }
    const r = this.ref();
    if (ts.acceptOp("(")) {
      const args = [];
      while (!ts.atEnd() && !ts.isOp(")")) {
        if (ts.acceptOp(",")) continue;
        args.push(this.expr());
      }
      ts.expectOp(")");
      return { kind: "call", name: r.path.join("."), args, loc };
    }
    return r;
  }

  unit() {
    const ts = this.ts;
    const u = ts.peek();
    if (u.type === "id" && ["ps", "ns", "us", "ms", "sec", "min", "hr"].includes(u.lower)) {
      ts.next();
      return u.value;
    }
    return null;
  }
}
