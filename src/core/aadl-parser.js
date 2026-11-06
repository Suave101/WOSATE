// Recursive-descent parser for textual AADL v2 (packages and property sets).
// It covers the declarative core that analyses need and recovers at
// classifier boundaries so one bad declaration does not hide the rest.

import { tokenize, TokenStream, ParseError, AADL_OPERATORS } from "./lexer.js";

const CATEGORIES = [
  ["thread", "group"],
  ["virtual", "processor"],
  ["virtual", "bus"],
  ["subprogram", "group"],
  ["system"], ["process"], ["thread"], ["processor"], ["memory"], ["bus"], ["device"],
  ["data"], ["subprogram"], ["abstract"],
];

const RESERVED_SECTIONS = new Set([
  "features", "flows", "modes", "properties", "annex", "prototypes", "requires", "subcomponents", "connections",
  "calls", "internal", "end", "applies",
]);

const TYPE_SECTIONS = ["prototypes", "features", "flows", "modes", "properties", "annex", "requires"];
const IMPL_SECTIONS = [
  "prototypes", "subcomponents", "internal", "processor", "calls", "connections", "flows", "modes",
  "properties", "annex",
];

/** Summarise the tokens of a property set declaration `name : <body> ;`. */
function summariseDefinition(name, loc, body) {
  const words = body.map((t) => (t.type === "id" ? t.lower : t.value));
  let i = 0;
  const isType = words[0] === "type";
  const isConstant = words[0] === "constant";
  if (isType || isConstant || words[0] === "inherit") i++;
  // Only top-level `applies to` / `=>` end the type; units lists also contain `=>`.
  const depths = [];
  let depth = 0;
  for (const w of words) {
    if (w === ")" || w === "]") depth--;
    depths.push(depth);
    if (w === "(" || w === "[") depth++;
  }
  const appliesAt = words.findIndex((w, k) => depths[k] === 0 && w === "applies" && words[k + 1] === "to");
  const defaultAt = words.findIndex((w, k) => depths[k] === 0 && w === "=>");
  const typeEnd = Math.min(...[appliesAt, defaultAt, words.length].filter((k) => k >= 0));
  const typeTokens = body.slice(i, typeEnd);
  const typeText = typeTokens.map((t) => t.value).join(" ").replace(/ :: /g, "::").replace(/\( /g, "(").replace(/ \)/g, ")").replace(/ ,/g, ",");
  const def = { name, loc, isType, isConstant, typeText, isList: words[i] === "list", enumLiterals: [], units: [], appliesTo: [] };
  const enumAt = words.indexOf("enumeration", i);
  if (enumAt >= 0 && enumAt < typeEnd) {
    for (let k = enumAt + 2; k < typeEnd && words[k] !== ")"; k++) if (body[k].type === "id") def.enumLiterals.push(body[k].value);
  }
  const unitsAt = words.indexOf("units", i);
  if (unitsAt >= 0 && unitsAt < typeEnd && words[unitsAt + 1] === "(") {
    for (let k = unitsAt + 2; k < typeEnd && words[k] !== ")"; k++) {
      if (body[k].type === "id" && (words[k - 1] === "(" || words[k - 1] === ",")) def.units.push(body[k].value);
    }
  }
  if (appliesAt >= 0) {
    let cur = [];
    for (let k = appliesAt + 3; k < body.length && words[k] !== ")"; k++) {
      if (words[k] === ",") {
        if (cur.length) def.appliesTo.push(cur.join(" "));
        cur = [];
      } else if (body[k].type === "id") cur.push(words[k]);
    }
    if (cur.length) def.appliesTo.push(cur.join(" "));
  }
  const scalar = ["aadlboolean", "aadlstring", "aadlinteger", "aadlreal", "enumeration", "range", "record", "reference", "classifier", "units"];
  const rest = words.slice(i + (def.isList ? 2 : 0), typeEnd);
  if (!isType && !isConstant && rest.length && !scalar.includes(rest[0]) && rest.every((w) => w === "::" || /^[a-z_]\w*$/.test(w))) {
    def.typeRef = rest.length === 3 ? `${typeTokens.at(-3).value}::${typeTokens.at(-1).value}` : typeTokens.at(-1).value;
  }
  return def;
}

function loc(tok, file) {
  return { file, line: tok.line, col: tok.col, pos: tok.pos };
}

export function parseAadl(text, file = "<input>") {
  const diagnostics = [];
  const tokens = tokenize(text, {
    operators: AADL_OPERATORS,
    annexBlocks: true,
    onError: (e) => diagnostics.push({ file, line: e.line, col: e.col, severity: "error", message: e.message, source: "lexer" }),
  });
  const p = new AadlParser(new TokenStream(tokens), file, diagnostics);
  const units = p.parseModelUnits();
  return { units, diagnostics };
}

/**
 * Parse AADL property associations from a token stream positioned at the first
 * association; used by annexes (EMV2, Behavior) whose `properties` sections use
 * core AADL syntax. Stops at the first token that does not start an association.
 */
export function parsePropertyAssociationsFrom(ts, file, diagnostics) {
  const p = new AadlParser(ts, file, diagnostics);
  const out = [];
  p.parsePropertyAssociations(out);
  return out;
}

class AadlParser {
  constructor(ts, file, diagnostics) {
    this.ts = ts;
    this.file = file;
    this.diagnostics = diagnostics;
  }

  error(err) {
    const t = err.token || this.ts.peek();
    this.diagnostics.push({
      file: this.file, line: t.line, col: t.col, severity: "error", message: err.message, source: "parser",
    });
  }

  loc(tok) {
    return loc(tok || this.ts.peek(), this.file);
  }

  // ---- top level -------------------------------------------------------

  parseModelUnits() {
    const units = [];
    const ts = this.ts;
    while (!ts.atEnd()) {
      try {
        if (ts.isKw("package")) units.push(this.parsePackage());
        else if (ts.isKw("property") && ts.isKw("set", 1)) units.push(this.parsePropertySet());
        else throw new ParseError(`Expected 'package' or 'property set' but found '${ts.peek().value}'`, ts.peek());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e);
        // Skip to the next model unit.
        ts.next();
        while (!ts.atEnd() && !ts.isKw("package") && !(ts.isKw("property") && ts.isKw("set", 1))) ts.next();
      }
    }
    return units;
  }

  parseQName() {
    const first = this.ts.expectId();
    let name = first.value;
    while (this.ts.isOp("::")) {
      this.ts.next();
      name += "::" + this.ts.expectId().value;
    }
    return { name, tok: first };
  }

  parsePackage() {
    const ts = this.ts;
    const start = ts.expectKw("package");
    const { name, tok } = this.parseQName();
    const pkg = {
      kind: "package", name, file: this.file, loc: this.loc(start), nameLoc: this.loc(tok), withs: [], classifiers: [],
      annexLibraries: [], properties: [], renames: [],
    };
    let visibility = "public";
    while (!ts.atEnd()) {
      if (ts.acceptKw("public")) { visibility = "public"; continue; }
      if (ts.acceptKw("private")) { visibility = "private"; continue; }
      if (ts.isKw("with")) { this.parseWith(pkg); continue; }
      if (ts.isKw("end")) break;
      if (ts.isKw("properties")) {
        ts.next();
        this.parsePropertyAssociations(pkg.properties);
        continue;
      }
      if (ts.isKw("annex")) {
        const a = this.parseAnnex();
        a.visibility = visibility;
        pkg.annexLibraries.push(a);
        continue;
      }
      if (ts.peek().type === "id" && ts.isKw("renames", 1)) {
        // alias declarations: skip
        while (!ts.atEnd() && !ts.isOp(";")) ts.next();
        ts.acceptOp(";");
        continue;
      }
      const startPos = ts.peek().pos;
      this.partial = null;
      try {
        const c = this.parseClassifier(pkg);
        c.visibility = visibility;
        c.startPos = startPos;
        pkg.classifiers.push(c);
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e);
        this.recoverClassifier();
        // Keep what was parsed so editor features still see the classifier.
        if (this.partial) {
          Object.assign(this.partial, { visibility, startPos, endPos: ts.lastEnd(), incomplete: true });
          pkg.classifiers.push(this.partial);
        }
      }
    }
    const endTok = ts.peek();
    try {
      ts.expectKw("end");
      const endName = this.parseQName().name;
      if (endName.toLowerCase() !== name.toLowerCase()) {
        this.diagnostics.push({
          file: this.file, line: endTok.line, col: endTok.col, severity: "error", source: "parser",
          message: `Package '${name}' is closed by 'end ${endName}'`,
        });
      }
      ts.expectOp(";");
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.error(e);
    }
    pkg.endPos = ts.lastEnd();
    return pkg;
  }

  parseWith(pkg) {
    const ts = this.ts;
    ts.expectKw("with");
    do {
      const t = ts.peek();
      const { name } = this.parseQName();
      pkg.withs.push({ name, loc: this.loc(t) });
    } while (ts.acceptOp(","));
    ts.expectOp(";");
  }

  /** Skip tokens until just after `end <name>;` that closes a classifier. */
  recoverClassifier() {
    const ts = this.ts;
    while (!ts.atEnd()) {
      if (ts.isKw("end") && ts.peek(1).type === "id") {
        // `end X;` or `end X.Y;` closes a classifier; `end Pkg;` the package
        let k = 2;
        if (ts.isOp(".", 2) && ts.peek(3).type === "id") k = 4;
        if (ts.isOp(";", k)) {
          // Peek further: if what follows looks like EOF / another package, this was the package end.
          const after = ts.peek(k + 1);
          const closesPackage = after.type === "eof" || (after.type === "id" && ["package", "property"].includes(after.lower));
          if (closesPackage && k === 2) return;
          for (let n = 0; n <= k; n++) ts.next();
          return;
        }
      }
      ts.next();
    }
  }

  parseCategory() {
    const ts = this.ts;
    for (const words of CATEGORIES) {
      if (words.every((w, k) => ts.isKw(w, k))) {
        // 'thread group' vs 'thread Group_name': only take 'group' if followed by an identifier or 'implementation'
        if (words.length === 2) {
          const after = ts.peek(2);
          if (!(after.type === "id")) continue;
        }
        words.forEach(() => ts.next());
        return words.join(" ");
      }
    }
    return null;
  }

  parseClassifier(pkg) {
    const ts = this.ts;
    const start = ts.peek();
    const category = this.parseCategory();
    if (!category) throw new ParseError(`Expected a component classifier but found '${start.value}'`, start);
    if (ts.acceptKw("implementation")) return this.parseImplementation(category, start, pkg);
    const nameTok = ts.expectId("component type name");
    const ct = {
      kind: "componentType", category, name: nameTok.value, pkg: pkg.name, loc: this.loc(nameTok),
      extends: null, features: [], flows: [], properties: [], annexes: [], modes: [], modeTransitions: [],
    };
    this.partial = ct;
    if (ts.acceptKw("extends")) ct.extends = this.parseClassifierRef();
    while (!ts.atEnd() && !ts.isKw("end")) {
      const sec = ts.peek();
      if (ts.acceptKw("features")) {
        if (this.acceptNone()) continue;
        this.members(ct.features, () => this.parseFeature());
      } else if (ts.acceptKw("flows")) {
        if (this.acceptNone()) continue;
        this.members(ct.flows, () => this.parseFlowSpec());
      } else if (ts.acceptKw("properties")) {
        this.parsePropertyAssociations(ct.properties);
      } else if (ts.isKw("annex")) {
        ct.annexes.push(this.parseAnnex());
      } else if (ts.acceptKw("modes")) {
        this.parseModes(ct);
      } else if (ts.acceptKw("prototypes")) {
        this.skipSection(TYPE_SECTIONS);
      } else if (ts.acceptKw("requires")) {
        ts.expectKw("modes");
        ct.requiresModes = true;
        this.parseModes(ct);
      } else {
        throw new ParseError(`Unexpected '${sec.value}' in component type '${ct.name}'`, sec);
      }
    }
    this.parseEnd(ct.name);
    ct.endPos = this.ts.lastEnd();
    return ct;
  }

  parseImplementation(category, start, pkg) {
    const ts = this.ts;
    const typeTok = ts.expectId("component type name");
    ts.expectOp(".");
    const implTok = ts.expectId("implementation name");
    const ci = {
      kind: "componentImpl", category, name: `${typeTok.value}.${implTok.value}`, typeName: typeTok.value,
      pkg: pkg.name, loc: this.loc(typeTok), extends: null, subcomponents: [], connections: [], flows: [],
      properties: [], annexes: [], modes: [], modeTransitions: [], callSequences: [],
    };
    this.partial = ci;
    if (ts.acceptKw("extends")) ci.extends = this.parseClassifierRef();
    while (!ts.atEnd() && !ts.isKw("end")) {
      const sec = ts.peek();
      if (ts.acceptKw("subcomponents")) {
        if (this.acceptNone()) continue;
        this.members(ci.subcomponents, () => this.parseSubcomponent());
      } else if (ts.acceptKw("connections")) {
        if (this.acceptNone()) continue;
        this.members(ci.connections, () => this.parseConnection());
      } else if (ts.acceptKw("flows")) {
        if (this.acceptNone()) continue;
        this.members(ci.flows, () => this.parseImplFlow());
      } else if (ts.acceptKw("properties")) {
        this.parsePropertyAssociations(ci.properties);
      } else if (ts.isKw("annex")) {
        ci.annexes.push(this.parseAnnex());
      } else if (ts.acceptKw("modes")) {
        this.parseModes(ci);
      } else if (ts.acceptKw("calls")) {
        if (this.acceptNone()) continue;
        this.members(ci.callSequences, () => this.parseCallSequence());
      } else if (ts.acceptKw("prototypes")) {
        this.skipSection(IMPL_SECTIONS);
      } else if (ts.acceptKw("internal") || ts.acceptKw("processor")) {
        ts.expectKw("features");
        this.skipSection(IMPL_SECTIONS);
      } else {
        throw new ParseError(`Unexpected '${sec.value}' in component implementation '${ci.name}'`, sec);
      }
    }
    this.parseEnd(ci.name);
    ci.endPos = this.ts.lastEnd();
    return ci;
  }

  parseEnd(name) {
    const ts = this.ts;
    const t = ts.expectKw("end");
    let endName = ts.expectId().value;
    if (ts.acceptOp(".")) endName += "." + ts.expectId().value;
    if (endName.toLowerCase() !== name.toLowerCase()) {
      this.diagnostics.push({
        file: this.file, line: t.line, col: t.col, severity: "error", source: "parser",
        message: `'${name}' is closed by 'end ${endName}'`,
      });
    }
    ts.expectOp(";");
  }

  acceptNone() {
    if (this.ts.isKw("none") && this.ts.isOp(";", 1)) {
      this.ts.next();
      this.ts.next();
      return true;
    }
    return false;
  }

  /** A member declaration starts with `name :` (and is not a section keyword). */
  isMemberStart() {
    const ts = this.ts;
    return ts.peek().type === "id" && ts.isOp(":", 1);
  }

  /** Parse `name : ...;` members, recovering at the next ';' so one bad member keeps the rest. */
  members(list, parse) {
    const ts = this.ts;
    while (this.isMemberStart()) {
      const start = ts.peek();
      try {
        list.push(parse());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e);
        while (!ts.atEnd()) {
          const t = ts.peek();
          if (t.type === "op" && t.value === ";") {
            ts.next();
            break;
          }
          if (t.type === "id" && t.line > start.line && (RESERVED_SECTIONS.has(t.lower) || t.lower === "end")) break;
          ts.next();
        }
      }
    }
  }

  /** A classifier reference may follow, i.e. the next token is a name and not a reserved word. */
  atClassifierRef() {
    const t = this.ts.peek();
    return t.type === "id" && !RESERVED_SECTIONS.has(t.lower) && t.lower !== "in" && t.lower !== "end";
  }

  skipSection(sections) {
    const ts = this.ts;
    while (!ts.atEnd() && !ts.isKw("end") && !sections.some((s) => ts.isKw(s) && !ts.isOp(":", 1))) ts.next();
  }

  parseClassifierRef() {
    const ts = this.ts;
    const t = ts.peek();
    let { name } = this.parseQName();
    if (ts.isOp(".") && ts.peek(1).type === "id") {
      ts.next();
      name += "." + ts.next().value;
    }
    return { name, loc: this.loc(t) };
  }

  acceptRefinedTo() {
    if (this.ts.isKw("refined") && this.ts.isKw("to", 1)) {
      this.ts.next();
      this.ts.next();
      return true;
    }
    return false;
  }

  skipArrayDims() {
    const ts = this.ts;
    const dims = [];
    while (ts.acceptOp("[")) {
      const t = ts.peek();
      if (t.type === "int") dims.push(Number(ts.next().value));
      while (!ts.atEnd() && !ts.isOp("]")) ts.next();
      ts.expectOp("]");
    }
    return dims;
  }

  parseCurlyProperties(target) {
    if (this.ts.acceptOp("{")) {
      while (!this.ts.atEnd() && !this.ts.isOp("}")) target.push(this.parsePropertyAssociation());
      this.ts.expectOp("}");
    }
  }

  skipInModes() {
    const ts = this.ts;
    if (ts.isKw("in") && ts.isKw("modes", 1)) {
      ts.next(); ts.next();
      ts.expectOp("(");
      let depth = 1;
      while (!ts.atEnd() && depth > 0) {
        const t = ts.next();
        if (t.type === "op" && t.value === "(") depth++;
        if (t.type === "op" && t.value === ")") depth--;
      }
    }
  }

  // ---- features --------------------------------------------------------

  parseFeature() {
    const ts = this.ts;
    const nameTok = ts.expectId();
    ts.expectOp(":");
    const f = {
      kind: "feature", name: nameTok.value, loc: this.loc(nameTok), direction: null, featureKind: null,
      access: null, classifier: null, properties: [], refined: this.acceptRefinedTo(),
    };
    if (ts.isKw("requires") || ts.isKw("provides")) {
      f.access = ts.next().lower;
      const parts = [];
      while (!ts.isKw("access")) {
        const t = ts.expectId("access category");
        parts.push(t.lower);
      }
      ts.expectKw("access");
      f.featureKind = `${parts.join(" ")} access`;
    } else {
      if (ts.isKw("in") && ts.isKw("out", 1)) {
        ts.next(); ts.next();
        f.direction = "in out";
      } else if (ts.acceptKw("in")) f.direction = "in";
      else if (ts.acceptKw("out")) f.direction = "out";
      if (ts.isKw("event") && ts.isKw("data", 1) && ts.isKw("port", 2)) {
        ts.next(); ts.next(); ts.next();
        f.featureKind = "event data port";
      } else if (ts.isKw("data") && ts.isKw("port", 1)) {
        ts.next(); ts.next();
        f.featureKind = "data port";
      } else if (ts.isKw("event") && ts.isKw("port", 1)) {
        ts.next(); ts.next();
        f.featureKind = "event port";
      } else if (ts.isKw("feature") && ts.isKw("group", 1)) {
        ts.next(); ts.next();
        f.featureKind = "feature group";
        ts.acceptKw("inverse") && ts.acceptKw("of");
      } else if (ts.acceptKw("parameter")) f.featureKind = "parameter";
      else if (ts.acceptKw("feature")) f.featureKind = "feature";
      else throw new ParseError(`Expected a feature category for '${f.name}' but found '${ts.peek().value}'`, ts.peek());
    }
    if (this.atClassifierRef()) f.classifier = this.parseClassifierRef();
    f.arrayDims = this.skipArrayDims();
    this.parseCurlyProperties(f.properties);
    ts.expectOp(";");
    return f;
  }

  parseFlowSpec() {
    const ts = this.ts;
    const nameTok = ts.expectId();
    ts.expectOp(":");
    this.acceptRefinedTo();
    ts.expectKw("flow");
    const kindTok = ts.expectId("flow kind");
    const kind = kindTok.lower;
    if (!["source", "sink", "path"].includes(kind)) throw new ParseError(`Unknown flow kind '${kindTok.value}'`, kindTok);
    const fs = { kind: "flowSpec", name: nameTok.value, flowKind: kind, loc: this.loc(nameTok), in: null, out: null, properties: [] };
    const featRef = () => {
      let n = ts.expectId().value;
      while (ts.acceptOp(".")) n += "." + ts.expectId().value;
      return n;
    };
    if (kind === "source") fs.out = featRef();
    else if (kind === "sink") fs.in = featRef();
    else {
      fs.in = featRef();
      ts.expectOp("->");
      fs.out = featRef();
    }
    this.parseCurlyProperties(fs.properties);
    this.skipInModes();
    ts.expectOp(";");
    return fs;
  }

  // ---- implementation members -----------------------------------------

  parseSubcomponent() {
    const ts = this.ts;
    const nameTok = ts.expectId();
    ts.expectOp(":");
    const refined = this.acceptRefinedTo();
    const catTok = ts.peek();
    const category = this.parseCategory();
    if (!category) throw new ParseError(`Expected a component category for subcomponent '${nameTok.value}'`, catTok);
    const sc = {
      kind: "subcomponent", name: nameTok.value, category, classifier: null, properties: [], refined,
      loc: this.loc(nameTok),
    };
    if (this.atClassifierRef()) sc.classifier = this.parseClassifierRef();
    sc.arrayDims = this.skipArrayDims();
    this.parseCurlyProperties(sc.properties);
    this.skipInModes();
    ts.expectOp(";");
    return sc;
  }

  parseConnectionEnd() {
    const ts = this.ts;
    const a = ts.expectId("connection end");
    if (ts.acceptOp(".")) {
      const b = ts.expectId("feature name");
      return { context: a.value, feature: b.value };
    }
    return { context: null, feature: a.value };
  }

  parseConnection() {
    const ts = this.ts;
    const nameTok = ts.expectId();
    ts.expectOp(":");
    this.acceptRefinedTo();
    const words = [];
    while (ts.peek().type === "id" && !(ts.isOp(".", 1) || ts.isOp("->", 1) || ts.isOp("<->", 1))) {
      words.push(ts.next().lower);
    }
    if (!words.length) throw new ParseError(`Expected a connection kind for '${nameTok.value}'`, ts.peek());
    const conn = {
      kind: "connection", name: nameTok.value, connectionKind: words.join(" "), loc: this.loc(nameTok),
      src: null, dst: null, bidirectional: false, properties: [],
    };
    conn.src = this.parseConnectionEnd();
    if (ts.acceptOp("<->")) conn.bidirectional = true;
    else ts.expectOp("->");
    conn.dst = this.parseConnectionEnd();
    this.parseCurlyProperties(conn.properties);
    this.skipInModes();
    ts.expectOp(";");
    return conn;
  }

  parseImplFlow() {
    const ts = this.ts;
    const nameTok = ts.expectId();
    ts.expectOp(":");
    this.acceptRefinedTo();
    const fl = { kind: "flowImpl", name: nameTok.value, loc: this.loc(nameTok), flowKind: null, segments: [], properties: [] };
    if (ts.isKw("end") && ts.isKw("to", 1) && ts.isKw("end", 2)) {
      ts.next(); ts.next(); ts.next();
      ts.expectKw("flow");
      fl.flowKind = "end to end";
    } else {
      ts.expectKw("flow");
      fl.flowKind = ts.expectId("flow kind").lower;
    }
    const seg = () => {
      let n = ts.expectId().value;
      while (ts.acceptOp(".")) n += "." + ts.expectId().value;
      return n;
    };
    fl.segments.push(seg());
    while (ts.acceptOp("->")) fl.segments.push(seg());
    this.parseCurlyProperties(fl.properties);
    this.skipInModes();
    ts.expectOp(";");
    return fl;
  }

  /** `modes` section: `m: [initial] mode;` and `t: m1 -[ trigger, ... ]-> m2;`. */
  parseModes(owner) {
    if (this.acceptNone()) return;
    const ts = this.ts;
    this.members(owner.modes, () => {
      const nameTok = ts.expectId("mode name");
      ts.expectOp(":");
      if (ts.isKw("initial") || ts.isKw("mode")) {
        const initial = !!ts.acceptKw("initial");
        ts.expectKw("mode");
        const mode = { kind: "mode", name: nameTok.value, initial, loc: this.loc(nameTok), properties: [] };
        this.parseCurlyProperties(mode.properties);
        ts.expectOp(";");
        return mode;
      }
      // A transition: parsed here, then moved to modeTransitions.
      const src = ts.expectId("source mode").value;
      ts.expectOp("-");
      ts.expectOp("[");
      const triggers = [];
      while (!ts.atEnd() && !ts.isOp("]")) {
        if (ts.acceptOp(",")) continue;
        let t = ts.expectId("trigger").value;
        while (ts.acceptOp(".")) t += "." + ts.expectId().value;
        triggers.push(t);
      }
      ts.expectOp("]");
      ts.expectOp("->");
      const dst = ts.expectId("destination mode").value;
      const tr = { kind: "modeTransition", name: nameTok.value, src, dst, triggers, loc: this.loc(nameTok), properties: [] };
      this.parseCurlyProperties(tr.properties);
      ts.expectOp(";");
      owner.modeTransitions.push(tr);
      return null;
    });
    owner.modes = owner.modes.filter(Boolean);
  }

  /** `seq: { call: subprogram Classifier; ... } [in modes (...)];` */
  parseCallSequence() {
    const ts = this.ts;
    const nameTok = ts.expectId("call sequence name");
    ts.expectOp(":");
    ts.expectOp("{");
    const seq = { kind: "callSequence", name: nameTok.value, calls: [], loc: this.loc(nameTok), properties: [] };
    while (!ts.atEnd() && !ts.isOp("}")) {
      const callTok = ts.expectId("call name");
      ts.expectOp(":");
      ts.expectKw("subprogram");
      const call = { kind: "subprogramCall", name: callTok.value, loc: this.loc(callTok), classifier: null, properties: [] };
      if (this.atClassifierRef()) call.classifier = this.parseClassifierRef();
      this.parseCurlyProperties(call.properties);
      ts.expectOp(";");
      seq.calls.push(call);
    }
    ts.expectOp("}");
    this.parseCurlyProperties(seq.properties);
    this.skipInModes();
    ts.expectOp(";");
    return seq;
  }

  // ---- annexes ----------------------------------------------------------

  parseAnnex() {
    const ts = this.ts;
    const start = ts.expectKw("annex");
    const nameTok = ts.expectId("annex name");
    const annex = { kind: "annex", name: nameTok.value, lname: nameTok.lower, loc: this.loc(start), text: "", bodyLoc: null };
    if (ts.peek().type === "annex") {
      const body = ts.next();
      annex.text = body.value;
      annex.bodyLoc = { file: this.file, line: body.bodyLine, col: body.bodyCol, pos: body.pos + 3 };
      annex.bodyEnd = body.end - 3;
    } else if (!ts.acceptKw("none")) {
      throw new ParseError(`Expected '{** ... **}' after 'annex ${nameTok.value}'`, ts.peek());
    }
    this.skipInModes();
    ts.expectOp(";");
    return annex;
  }

  // ---- properties ---------------------------------------------------------

  parsePropertyAssociations(target) {
    if (this.acceptNone()) return;
    const ts = this.ts;
    while (!ts.atEnd() && ts.peek().type === "id" && (ts.isOp("=>", 1) || ts.isOp("+=>", 1) || ts.isOp("::", 1))) {
      try {
        target.push(this.parsePropertyAssociation());
      } catch (e) {
        if (!(e instanceof ParseError)) throw e;
        this.error(e);
        while (!ts.atEnd() && !ts.isOp(";") && !ts.isKw("end")) ts.next();
        ts.acceptOp(";");
      }
    }
  }

  parsePropertyAssociation() {
    const ts = this.ts;
    const start = ts.peek();
    const { name } = this.parseQName();
    const pa = { kind: "propertyAssociation", name, loc: this.loc(start), append: false, constant: false, value: null, appliesTo: [] };
    if (ts.acceptOp("+=>")) pa.append = true;
    else ts.expectOp("=>");
    if (ts.acceptKw("constant")) pa.constant = true;
    pa.value = this.parsePropertyValue();
    if (ts.isKw("applies") && ts.isKw("to", 1)) {
      ts.next(); ts.next();
      do {
        let path = ts.expectId().value;
        this.skipArrayDims();
        while (ts.acceptOp(".")) {
          path += "." + ts.expectId().value;
          this.skipArrayDims();
        }
        pa.appliesTo.push(path);
      } while (ts.acceptOp(","));
    }
    if (ts.isKw("in") && ts.isKw("binding", 1)) {
      ts.next(); ts.next();
      ts.expectOp("(");
      while (!ts.atEnd() && !ts.isOp(")")) ts.next();
      ts.expectOp(")");
    }
    this.skipInModes();
    ts.expectOp(";");
    return pa;
  }

  parsePropertyValue() {
    const ts = this.ts;
    const t = ts.peek();
    let v;
    if (ts.isOp("(")) {
      ts.next();
      const items = [];
      if (!ts.isOp(")")) {
        do items.push(this.parsePropertyValue());
        while (ts.acceptOp(","));
      }
      ts.expectOp(")");
      return { type: "list", items };
    }
    if (ts.isOp("[")) {
      ts.next();
      const fields = {};
      while (!ts.atEnd() && !ts.isOp("]")) {
        const f = ts.expectId("record field");
        ts.expectOp("=>");
        fields[f.lower] = this.parsePropertyValue();
        ts.expectOp(";");
      }
      ts.expectOp("]");
      return { type: "record", fields };
    }
    if (t.type === "string") {
      ts.next();
      return { type: "string", value: t.value };
    }
    if (ts.isKw("reference") && ts.isOp("(", 1)) {
      ts.next(); ts.next();
      let path = ts.expectId().value;
      while (ts.acceptOp(".")) path += "." + ts.expectId().value;
      ts.expectOp(")");
      return { type: "reference", path };
    }
    if (ts.isKw("classifier") && ts.isOp("(", 1)) {
      ts.next(); ts.next();
      const ref = this.parseClassifierRef();
      ts.expectOp(")");
      return { type: "classifier", name: ref.name };
    }
    if (ts.isKw("compute") && ts.isOp("(", 1)) {
      ts.next(); ts.next();
      const id = ts.expectId().value;
      ts.expectOp(")");
      return { type: "computed", function: id };
    }
    if (ts.isKw("true") || ts.isKw("false")) {
      ts.next();
      return { type: "bool", value: t.lower === "true" };
    }
    v = this.parseNumberOrRef();
    if (ts.acceptOp("..")) {
      const max = this.parseNumberOrRef();
      const range = { type: "range", min: v, max, delta: null };
      if (ts.acceptKw("delta")) range.delta = this.parseNumberOrRef();
      return range;
    }
    return v;
  }

  parseNumberOrRef() {
    const ts = this.ts;
    let sign = 1;
    if (ts.acceptOp("-")) sign = -1;
    else ts.acceptOp("+");
    const t = ts.peek();
    if (t.type === "int" || t.type === "real") {
      ts.next();
      const value = sign * Number(t.value);
      let unit = null;
      if (ts.peek().type === "id" && !ts.isKw("applies") && !ts.isKw("in") && !ts.isKw("delta")) unit = ts.next().value;
      return { type: "number", value, isReal: t.type === "real", unit };
    }
    if (t.type === "id") {
      const { name } = this.parseQName();
      return { type: "name", name, negated: sign < 0 };
    }
    throw new ParseError(`Expected a property value but found '${t.value}'`, t);
  }

  // ---- property sets --------------------------------------------------------

  parsePropertySet() {
    const ts = this.ts;
    const start = ts.expectKw("property");
    ts.expectKw("set");
    const nameTok = ts.expectId("property set name");
    ts.expectKw("is");
    const ps = { kind: "propertySet", name: nameTok.value, file: this.file, loc: this.loc(start), nameLoc: this.loc(nameTok), withs: [], definitions: [] };
    while (ts.isKw("with")) this.parseWith(ps);
    // Property definitions, types and constants are summarised (type text,
    // enumeration literals, applies-to categories) for validation and completion.
    while (!ts.atEnd()) {
      if (ts.isKw("end") && ts.peek(1).type === "id" && ts.peek(1).lower === nameTok.lower && ts.isOp(";", 2)) break;
      if (ts.peek().type === "id" && ts.isOp(":", 1)) {
        const d = ts.next();
        ts.next();
        const body = [];
        let depth = 0;
        while (!ts.atEnd()) {
          if (ts.isOp("(") || ts.isOp("[")) depth++;
          if (ts.isOp(")") || ts.isOp("]")) depth--;
          if (depth <= 0 && ts.isOp(";")) break;
          body.push(ts.next());
        }
        ts.acceptOp(";");
        ps.definitions.push(summariseDefinition(d.value, this.loc(d), body));
        continue;
      }
      ts.next();
    }
    try {
      ts.expectKw("end");
      ts.expectId();
      ts.expectOp(";");
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.error(e);
    }
    ps.endPos = ts.lastEnd();
    return ps;
  }
}
