// Parser for the Resolute assurance-case annex: claim functions
// (`name(args) <= ** "text" arg ** expr`), computational functions and
// constants (`name(args) : type = expr`), and `prove (...)` statements.

import { tokenize, TokenStream, ParseError } from "../../core/lexer.js";

const OPS = ["<=>", "=>", "<=", ">=", "<>", "!=", "**", "::", "=", "<", ">", "+", "-", "*", "/", "%", "(", ")", "{", "}", "[", "]", ",", ":", ";", ".", "|", "^"];

export const RESOLUTE_KEYWORDS = [
  "prove", "check", "forall", "exists", "and", "or", "not", "if", "then", "else", "let", "in", "for", "this", "true", "false",
  "component", "connection", "feature", "port", "property", "fail", "undeveloped", "lint", "error", "warning", "info",
];

export function parseResolute(text, ctx = {}) {
  const loc = ctx.loc || {};
  const file = loc.file;
  const diagnostics = [];
  const tokens = tokenize(text, {
    operators: OPS,
    line: loc.line || 1,
    col: loc.col || 1,
    offset: loc.pos || 0,
    onError: (e) => diagnostics.push({ file, line: e.line, col: e.col, severity: "error", message: e.message }),
  });
  const p = new ResoluteParser(new TokenStream(tokens), file, diagnostics);
  return { ast: p.parse(), diagnostics };
}

class ResoluteParser {
  constructor(ts, file, diagnostics) {
    this.ts = ts;
    this.file = file;
    this.diagnostics = diagnostics;
  }

  loc(t = this.ts.peek()) {
    return { file: this.file, line: t.line, col: t.col, pos: t.pos };
  }

  parse() {
    const ts = this.ts;
    const out = { kind: "resolute", definitions: [], proves: [] };
    while (!ts.atEnd()) {
      try {
        if (ts.isKw("prove") || ts.isKw("check")) {
          const t = ts.next();
          ts.expectOp("(");
          const call = this.expr();
          ts.expectOp(")");
          ts.acceptOp(";");
          if (call.kind !== "call") throw new ParseError("prove expects a claim call, e.g. prove (my_claim(this))", t);
          out.proves.push({ call, loc: this.loc(t) });
        } else {
          out.definitions.push(this.definition());
        }
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        const t = e.token || ts.peek();
        this.diagnostics.push({ file: this.file, line: t.line, col: t.col, severity: "error", message: e.message });
        // Skip to the next line-leading identifier followed by '(' or ':' (a new definition) or prove.
        const line = t.line;
        ts.next();
        while (!ts.atEnd() && !(ts.peek().line > line && ts.peek().type === "id" && (ts.isOp("(", 1) || ts.isOp(":", 1) || ts.isKw("prove") || ts.isKw("check")))) ts.next();
      }
    }
    return out;
  }

  type() {
    const ts = this.ts;
    if (ts.acceptOp("{")) {
      const inner = this.type();
      ts.expectOp("}");
      return `set of ${inner}`;
    }
    let n = ts.expectId("type").value;
    if (["thread", "virtual", "subprogram"].includes(n.toLowerCase()) && ts.peek().type === "id" && ["group", "processor", "bus"].includes(ts.peek().lower)) n += " " + ts.next().value;
    while (ts.acceptOp("::")) n += "::" + ts.expectId().value;
    if (ts.acceptOp("{")) {
      ts.expectOp("}");
      n = `set of ${n}`;
    }
    return n;
  }

  definition() {
    const ts = this.ts;
    const nameTok = ts.expectId("definition name");
    const def = { name: nameTok.value, params: [], loc: this.loc(nameTok) };
    if (ts.acceptOp("(")) {
      while (!ts.atEnd() && !ts.isOp(")")) {
        if (ts.acceptOp(",")) continue;
        const p = ts.expectId("parameter").value;
        ts.expectOp(":");
        def.params.push({ name: p, type: this.type() });
      }
      ts.expectOp(")");
    }
    if (ts.acceptOp("<=")) {
      def.kind = "claim";
      ts.expectOp("**");
      def.text = [];
      while (!ts.atEnd() && !ts.isOp("**")) {
        const t = ts.next();
        if (t.type === "string") def.text.push({ str: t.value });
        else if (t.type === "id") def.text.push({ ref: t.value });
        else if (t.type === "int" || t.type === "real") def.text.push({ str: t.value });
      }
      ts.expectOp("**");
      def.body = this.expr();
      return def;
    }
    ts.expectOp(":");
    def.kind = def.params.length || ts.isOp("(") ? "function" : "constant";
    def.type = this.type();
    ts.expectOp("=");
    def.body = this.expr();
    return def;
  }

  expr() {
    return this.implies();
  }

  implies() {
    const l = this.orExpr();
    if (this.ts.acceptOp("=>")) return { kind: "bin", op: "=>", l, r: this.implies() };
    return l;
  }

  orExpr() {
    let l = this.andExpr();
    while (this.ts.acceptKw("or")) l = { kind: "bin", op: "or", l, r: this.andExpr() };
    return l;
  }

  andExpr() {
    let l = this.notExpr();
    while (this.ts.acceptKw("and")) l = { kind: "bin", op: "and", l, r: this.notExpr() };
    return l;
  }

  notExpr() {
    const t = this.ts.peek();
    if (this.ts.acceptKw("not")) return { kind: "un", op: "not", e: this.notExpr(), loc: this.loc(t) };
    return this.rel();
  }

  rel() {
    const l = this.add();
    for (const op of ["=", "<>", "!=", "<", "<=", ">", ">="]) {
      if (this.ts.acceptOp(op)) return { kind: "bin", op: op === "!=" ? "<>" : op, l, r: this.add() };
    }
    return l;
  }

  add() {
    let l = this.mul();
    for (;;) {
      if (this.ts.acceptOp("+")) l = { kind: "bin", op: "+", l, r: this.mul() };
      else if (this.ts.acceptOp("-")) l = { kind: "bin", op: "-", l, r: this.mul() };
      else return l;
    }
  }

  mul() {
    let l = this.unary();
    for (;;) {
      if (this.ts.acceptOp("*")) l = { kind: "bin", op: "*", l, r: this.unary() };
      else if (this.ts.acceptOp("/")) l = { kind: "bin", op: "/", l, r: this.unary() };
      else if (this.ts.acceptOp("%")) l = { kind: "bin", op: "%", l, r: this.unary() };
      else return l;
    }
  }

  unary() {
    const t = this.ts.peek();
    if (this.ts.acceptOp("-")) return { kind: "un", op: "-", e: this.unary(), loc: this.loc(t) };
    return this.primary();
  }

  bindings() {
    const ts = this.ts;
    const out = [];
    while (ts.acceptOp("(")) {
      const names = [ts.expectId("variable").value];
      while (ts.acceptOp(",")) names.push(ts.expectId("variable").value);
      ts.expectOp(":");
      // The domain is a type name or a set expression.
      const domain = this.domain();
      ts.expectOp(")");
      for (const n of names) out.push({ name: n, domain });
    }
    return out;
  }

  domain() {
    const ts = this.ts;
    if (ts.peek().type === "id" && !ts.isOp("(", 1) && !ts.isOp("::", 1)) {
      const t = ts.peek();
      const words = ["thread", "virtual", "subprogram"].includes(t.lower) && ["group", "processor", "bus"].includes(ts.peek(1).lower) ? 2 : 1;
      if (ts.isOp(")", words)) {
        const parts = [];
        for (let k = 0; k < words; k++) parts.push(ts.next().lower);
        return { kind: "type", name: parts.join(" ") };
      }
    }
    return { kind: "expr", expr: this.expr() };
  }

  primary() {
    const ts = this.ts;
    const t = ts.peek();
    const loc = this.loc(t);
    if (t.type === "int" || t.type === "real") {
      ts.next();
      let unit = null;
      if (ts.peek().type === "id" && /^(ps|ns|us|ms|sec|min|hr|bits|bytes|kbyte|mbyte|gbyte|bitsps|bytesps|kbytesps|mbytesps|gbytesps|mips|kips|gips|hz|khz|mhz|ghz|g|kg|mw|w|kw)$/i.test(ts.peek().value)) unit = ts.next().value;
      return { kind: "lit", value: Number(t.value), unit, loc };
    }
    if (t.type === "string") {
      ts.next();
      return { kind: "lit", value: t.value, loc };
    }
    if (ts.acceptOp("(")) {
      const e = this.expr();
      ts.expectOp(")");
      return e;
    }
    if (ts.acceptOp("{")) {
      // set literal or comprehension
      if (ts.acceptOp("}")) return { kind: "set", items: [], loc };
      const first = this.expr();
      if (ts.acceptKw("for")) {
        const binds = this.bindings();
        let cond = null;
        if (ts.acceptOp("|")) cond = this.expr();
        ts.expectOp("}");
        return { kind: "comprehension", expr: first, bindings: binds, cond, loc };
      }
      const items = [first];
      while (ts.acceptOp(",")) items.push(this.expr());
      ts.expectOp("}");
      return { kind: "set", items, loc };
    }
    if (t.type !== "id") throw new ParseError(`Expected an expression but found '${t.value}'`, t);
    const kw = t.lower;
    if (kw === "true" || kw === "false") {
      ts.next();
      return { kind: "lit", value: kw === "true", loc };
    }
    if (kw === "forall" || kw === "exists") {
      ts.next();
      const binds = this.bindings();
      ts.expectOp(".");
      return { kind: "quant", quant: kw, bindings: binds, body: this.expr(), loc };
    }
    if (kw === "if") {
      ts.next();
      const c = this.expr();
      ts.expectKw("then");
      const a = this.expr();
      ts.expectKw("else");
      return { kind: "if", c, a, b: this.expr(), loc };
    }
    if (kw === "let") {
      ts.next();
      const name = ts.expectId("variable").value;
      ts.expectOp(":");
      this.type();
      ts.expectOp("=");
      const value = this.expr();
      ts.expectOp(";");
      return { kind: "let", name, value, body: this.expr(), loc };
    }
    ts.next();
    let name = t.value;
    while (ts.acceptOp("::")) name += "::" + ts.expectId().value;
    if (ts.acceptOp("(")) {
      const args = [];
      while (!ts.atEnd() && !ts.isOp(")")) {
        if (ts.acceptOp(",")) continue;
        args.push(this.expr());
      }
      ts.expectOp(")");
      return { kind: "call", name, args, loc };
    }
    return { kind: "id", name, loc };
  }
}
