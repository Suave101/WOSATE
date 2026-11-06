// Lexer + recursive-descent parser for the AGREE annex language subset.
// Unsupported constructs are reported as errors rather than silently ignored,
// so a "Valid" result never comes from a partially understood contract.

import { tokenize, TokenStream, ParseError } from "../../core/lexer.js";

const AGREE_OPERATORS = [
  "<=>", "=>", "->", "<>", "<=", ">=", "::", "=", "<", ">", "+", "-", "*", "/", "(", ")", ";", ":", ",", ".",
  "[", "]", "{", "}", "^", "#", "|",
];

export const AGREE_KEYWORDS = [
  "assume", "guarantee", "lemma", "assert", "eq", "const", "property", "node", "fun", "returns", "var", "let",
  "tel", "if", "then", "else", "and", "or", "not", "pre", "prev", "true", "false", "div", "mod", "int", "real",
  "bool", "floor", "initially", "synchrony", "calendar", "lift", "connection", "enum", "type", "event",
  "reachable",
];

const UNSUPPORTED_SPECS = {
  initially: "'initially' statements",
  synchrony: "synchrony specifications",
  calendar: "calendar specifications",
  lift: "'lift' statements",
  connection: "connection statements",
  type: "record and enumeration type declarations",
  enum: "enumeration types",
  reachable: "'reachable' statements",
  asynchronous: "asynchronous specifications",
  latched: "latched specifications",
};

/**
 * Parse an AGREE annex body.
 * @param {string} text
 * @param {{ kind: 'subclause' | 'library', loc?: { file, line, col } }} ctx
 */
export function parseAgree(text, ctx = {}) {
  const file = ctx.loc?.file;
  const diagnostics = [];
  const tokens = tokenize(text, {
    operators: AGREE_OPERATORS,
    line: ctx.loc?.line || 1,
    col: ctx.loc?.col || 1,
    onError: (e) => diagnostics.push({ file, line: e.line, col: e.col, severity: "error", message: e.message }),
  });
  const p = new AgreeParser(new TokenStream(tokens), file, diagnostics, ctx.kind || "subclause");
  const specs = p.parseSpecs();
  return { ast: { kind: "agree", annexKind: ctx.kind || "subclause", specs }, diagnostics };
}

class AgreeParser {
  constructor(ts, file, diagnostics, annexKind) {
    this.ts = ts;
    this.file = file;
    this.diagnostics = diagnostics;
    this.annexKind = annexKind;
  }

  loc(t) {
    t = t || this.ts.peek();
    return { file: this.file, line: t.line, col: t.col };
  }

  err(message, t) {
    return new ParseError(message, t || this.ts.peek());
  }

  report(e) {
    const t = e.token || this.ts.peek();
    this.diagnostics.push({ file: this.file, line: t.line, col: t.col, severity: "error", message: e.message });
  }

  parseSpecs() {
    const ts = this.ts;
    const specs = [];
    while (!ts.atEnd()) {
      try {
        specs.push(this.parseSpec());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.report(e);
        // Recover: skip past the next ';' (or 'tel;' for nodes).
        while (!ts.atEnd() && !ts.isOp(";")) ts.next();
        ts.acceptOp(";");
      }
    }
    return specs;
  }

  parseSpec() {
    const ts = this.ts;
    const t = ts.peek();
    if (t.type !== "id") throw this.err(`Expected an AGREE statement but found '${t.value}'`);
    const kw = t.lower;
    if (kw === "assume" || kw === "guarantee" || kw === "lemma") {
      ts.next();
      const spec = { kind: kw, id: null, desc: null, loc: this.loc(t) };
      if (ts.peek().type === "id") spec.id = ts.next().value;
      if (ts.peek().type === "string") spec.desc = ts.next().value;
      if (!spec.desc && !spec.id) throw this.err(`${kw} needs a description string, e.g. ${kw} "..." : expr;`);
      ts.expectOp(":");
      spec.expr = this.parseExpr();
      ts.expectOp(";");
      return spec;
    }
    if (kw === "assert") {
      ts.next();
      const spec = { kind: "assert", id: null, desc: null, loc: this.loc(t) };
      if (ts.peek().type === "id" && (ts.peek(1).type === "string" || ts.isOp(":", 1))) spec.id = ts.next().value;
      if (ts.peek().type === "string") {
        spec.desc = ts.next().value;
        ts.expectOp(":");
      } else if (spec.id) ts.expectOp(":");
      spec.expr = this.parseExpr();
      ts.expectOp(";");
      return spec;
    }
    if (kw === "eq") {
      ts.next();
      const vars = [this.parseTypedName()];
      while (ts.acceptOp(",")) vars.push(this.parseTypedName());
      const spec = { kind: "eq", vars, expr: null, loc: this.loc(t) };
      if (ts.acceptOp("=")) spec.expr = this.parseExpr();
      ts.expectOp(";");
      return spec;
    }
    if (kw === "const") {
      ts.next();
      const v = this.parseTypedName();
      ts.expectOp("=");
      const expr = this.parseExpr();
      ts.expectOp(";");
      return { kind: "const", name: v.name, type: v.type, expr, loc: this.loc(t) };
    }
    if (kw === "property") {
      ts.next();
      const name = ts.expectId().value;
      ts.expectOp("=");
      const expr = this.parseExpr();
      ts.expectOp(";");
      return { kind: "property", name, expr, loc: this.loc(t) };
    }
    if (kw === "node") return this.parseNode();
    if (kw === "fun") return this.parseFun();
    if (UNSUPPORTED_SPECS[kw]) throw this.err(`AGREE ${UNSUPPORTED_SPECS[kw]} are not supported yet`, t);
    throw this.err(`Unknown AGREE statement '${t.value}'`, t);
  }

  parseTypedName() {
    const name = this.ts.expectId("variable name");
    this.ts.expectOp(":");
    return { name: name.value, type: this.parseType(), loc: this.loc(name) };
  }

  parseType() {
    const ts = this.ts;
    const t = ts.expectId("type");
    let name = t.value;
    while (ts.acceptOp("::")) name += "::" + ts.expectId("type").value;
    if (ts.acceptOp(".")) name += "." + ts.expectId("type").value;
    if (ts.isOp("[")) throw this.err("Array types are not supported yet");
    return { name, loc: this.loc(t) };
  }

  parseParams() {
    const ts = this.ts;
    ts.expectOp("(");
    const params = [];
    if (!ts.isOp(")")) {
      do params.push(this.parseTypedName());
      while (ts.acceptOp(","));
    }
    ts.expectOp(")");
    return params;
  }

  parseNode() {
    const ts = this.ts;
    const start = ts.expectKw("node");
    const name = ts.expectId("node name").value;
    const params = this.parseParams();
    ts.expectKw("returns");
    const returns = this.parseParams();
    ts.expectOp(";");
    const locals = [];
    if (ts.acceptKw("var")) {
      while (ts.peek().type === "id" && !ts.isKw("let")) {
        locals.push(this.parseTypedName());
        ts.expectOp(";");
      }
    }
    ts.expectKw("let");
    const equations = [];
    const asserts = [];
    while (!ts.atEnd() && !ts.isKw("tel")) {
      const t = ts.peek();
      if (ts.acceptKw("assert")) {
        asserts.push(this.parseExpr());
        ts.expectOp(";");
        continue;
      }
      const lhs = [ts.expectId("equation target").value];
      while (ts.acceptOp(",")) lhs.push(ts.expectId("equation target").value);
      ts.expectOp("=");
      const expr = this.parseExpr();
      ts.expectOp(";");
      equations.push({ lhs, expr, loc: this.loc(t) });
    }
    ts.expectKw("tel");
    ts.expectOp(";");
    return { kind: "node", name, params, returns, locals, equations, asserts, loc: this.loc(start) };
  }

  parseFun() {
    const ts = this.ts;
    const start = ts.expectKw("fun");
    const name = ts.expectId("function name").value;
    const params = this.parseParams();
    ts.expectOp(":");
    const returnType = this.parseType();
    ts.expectOp("=");
    const expr = this.parseExpr();
    ts.expectOp(";");
    return { kind: "fun", name, params, returnType, expr, loc: this.loc(start) };
  }

  // ---- expressions --------------------------------------------------------
  // Precedence (lowest first): ->, =>, <=>, or, and, relational, + -, * / div mod, unary, primary.

  parseExpr() {
    return this.parseArrow();
  }

  bin(op, l, r, t) {
    return { k: "bin", op, l, r, loc: this.loc(t) };
  }

  parseArrow() {
    const l = this.parseImplies();
    const t = this.ts.peek();
    if (this.ts.acceptOp("->")) return { k: "arrow", l, r: this.parseArrow(), loc: this.loc(t) };
    return l;
  }

  parseImplies() {
    const l = this.parseEquiv();
    const t = this.ts.peek();
    if (this.ts.acceptOp("=>")) return this.bin("=>", l, this.parseImplies(), t);
    return l;
  }

  parseEquiv() {
    let l = this.parseOr();
    for (;;) {
      const t = this.ts.peek();
      if (!this.ts.acceptOp("<=>")) return l;
      l = this.bin("<=>", l, this.parseOr(), t);
    }
  }

  parseOr() {
    let l = this.parseAnd();
    for (;;) {
      const t = this.ts.peek();
      if (!this.ts.acceptKw("or")) return l;
      l = this.bin("or", l, this.parseAnd(), t);
    }
  }

  parseAnd() {
    let l = this.parseRel();
    for (;;) {
      const t = this.ts.peek();
      if (!this.ts.acceptKw("and")) return l;
      l = this.bin("and", l, this.parseRel(), t);
    }
  }

  parseRel() {
    const l = this.parseAdd();
    const t = this.ts.peek();
    for (const op of ["<", "<=", ">", ">=", "=", "<>"]) {
      if (this.ts.acceptOp(op)) return this.bin(op, l, this.parseAdd(), t);
    }
    return l;
  }

  parseAdd() {
    let l = this.parseMul();
    for (;;) {
      const t = this.ts.peek();
      if (this.ts.acceptOp("+")) l = this.bin("+", l, this.parseMul(), t);
      else if (this.ts.acceptOp("-")) l = this.bin("-", l, this.parseMul(), t);
      else return l;
    }
  }

  parseMul() {
    let l = this.parseUnary();
    for (;;) {
      const t = this.ts.peek();
      if (this.ts.acceptOp("*")) l = this.bin("*", l, this.parseUnary(), t);
      else if (this.ts.acceptOp("/")) l = this.bin("/", l, this.parseUnary(), t);
      else if (this.ts.acceptKw("div")) l = this.bin("div", l, this.parseUnary(), t);
      else if (this.ts.acceptKw("mod")) l = this.bin("mod", l, this.parseUnary(), t);
      else return l;
    }
  }

  parseUnary() {
    const t = this.ts.peek();
    if (this.ts.acceptKw("not")) return { k: "un", op: "not", e: this.parseUnary(), loc: this.loc(t) };
    if (this.ts.acceptOp("-")) return { k: "un", op: "-", e: this.parseUnary(), loc: this.loc(t) };
    return this.parsePrimary();
  }

  parsePrimary() {
    const ts = this.ts;
    const t = ts.peek();
    const loc = this.loc(t);
    if (t.type === "int") {
      ts.next();
      return { k: "int", v: t.value, loc };
    }
    if (t.type === "real") {
      ts.next();
      return { k: "real", v: t.value, loc };
    }
    if (ts.acceptOp("(")) {
      const e = this.parseExpr();
      ts.expectOp(")");
      return e;
    }
    if (t.type !== "id") throw this.err(`Expected an expression but found '${t.value}'`);
    const kw = t.lower;
    if (kw === "true" || kw === "false") {
      ts.next();
      return { k: "bool", v: kw === "true", loc };
    }
    if (kw === "if") {
      ts.next();
      const c = this.parseExpr();
      ts.expectKw("then");
      const a = this.parseExpr();
      ts.expectKw("else");
      const b = this.parseExpr();
      return { k: "ite", c, t: a, e: b, loc };
    }
    if (kw === "pre") {
      ts.next();
      ts.expectOp("(");
      const e = this.parseExpr();
      ts.expectOp(")");
      return { k: "pre", e, loc };
    }
    if (kw === "prev") {
      ts.next();
      ts.expectOp("(");
      const e = this.parseExpr();
      ts.expectOp(",");
      const init = this.parseExpr();
      ts.expectOp(")");
      return { k: "prev", e, init, loc };
    }
    if (kw === "event") throw this.err("event() expressions are not supported yet", t);
    if (kw === "real" || kw === "floor") {
      ts.next();
      ts.expectOp("(");
      const e = this.parseExpr();
      ts.expectOp(")");
      return { k: "cast", to: kw === "real" ? "real" : "int", e, loc };
    }
    // Identifier path: a, a.b, Pkg::name, Pkg::node(args), Pkg.node(args)
    ts.next();
    let name = t.value;
    while (ts.acceptOp("::")) name += "::" + ts.expectId().value;
    const path = [name];
    while (ts.isOp(".") && ts.peek(1).type === "id") {
      ts.next();
      path.push(ts.next().value);
    }
    if (ts.isOp("{")) throw this.err("Record expressions are not supported yet");
    if (ts.acceptOp("(")) {
      const args = [];
      if (!ts.isOp(")")) {
        do args.push(this.parseExpr());
        while (ts.acceptOp(","));
      }
      ts.expectOp(")");
      return { k: "call", name: path.join("."), args, loc };
    }
    return { k: "id", path, loc };
  }
}
