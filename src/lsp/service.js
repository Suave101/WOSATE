// AADL language service: the semantic engine behind the LSP server
// (src/lsp/worker.js). It resolves names across all workspace files and
// answers completion, definition, references, hover, rename, document
// symbols, folding ranges and diagnostics. Positions follow LSP conventions
// (0-based line/character); results use LSP shapes.

import { tokenize, AADL_OPERATORS } from "../core/lexer.js";
import { buildModel } from "../core/model.js";
import { PREDECLARED_SETS } from "../core/stdlib.js";

const lc = (s) => (s || "").toLowerCase();

export const CompletionItemKind = { Text: 1, Method: 2, Function: 3, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Property: 10, Unit: 11, Value: 12, Enum: 13, Keyword: 14, Snippet: 15, Reference: 18, Folder: 19, EnumMember: 20, Constant: 21, Struct: 22, Event: 23, TypeParameter: 25 };
export const SymbolKind = { File: 1, Module: 2, Namespace: 3, Package: 4, Class: 5, Method: 6, Property: 7, Field: 8, Interface: 11, Function: 12, Variable: 13, Constant: 14, Event: 24, Struct: 23 };
const Severity = { error: 1, warning: 2, info: 3 };

const CATEGORIES = ["system", "process", "thread", "thread group", "processor", "virtual processor", "memory", "bus", "virtual bus", "device", "data", "subprogram", "subprogram group", "abstract"];
const TYPE_SECTIONS = ["features", "flows", "modes", "properties", "annex", "prototypes", "requires"];
const IMPL_SECTIONS = ["subcomponents", "connections", "calls", "flows", "modes", "properties", "annex", "prototypes", "internal"];
const SECTION_WORDS = new Set([...TYPE_SECTIONS, ...IMPL_SECTIONS]);
const AGREE_OPS = ["<=>", "=>", "->", "<>", "<=", ">=", "::", "=", "<", ">", "+", "-", "*", "/", "(", ")", ";", ":", ",", ".", "[", "]", "{", "}"];

// ---- text positions -----------------------------------------------------------------

export function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

export function offsetAt(text, pos, starts = lineStarts(text)) {
  const line = Math.min(Math.max(0, pos.line), starts.length - 1);
  return Math.min(starts[line] + pos.character, line + 1 < starts.length ? starts[line + 1] - 1 : text.length);
}

export function positionAt(text, offset, starts = lineStarts(text)) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, character: offset - starts[lo] };
}

export const uriOf = (name) => `file:///${encodeURI(name)}`;
export const nameOf = (uri) => decodeURI(uri.replace(/^file:\/\/\//, ""));

const snippet = (label, body, detail, kind = CompletionItemKind.Snippet) => ({ label, kind, detail, insertText: body, insertTextFormat: 2 });
const kw = (label, detail) => ({ label, kind: CompletionItemKind.Keyword, detail });

export class LanguageService {
  /**
   * @param {{ host?: import('../core/plugin-host.js').PluginHost, libraries?: {name,text}[] }} opts
   */
  constructor({ host = null, libraries = [] } = {}) {
    this.host = host;
    this.libraries = new Map(libraries.map((l) => [l.name, l.text]));
    this.files = new Map();
    this._model = null;
    this._tokens = new Map();
  }

  setLibraries(libraries) {
    this.libraries = new Map(libraries.map((l) => [l.name, l.text]));
    this._model = null;
  }

  setFile(name, text) {
    if (this.files.get(name) === text) return;
    this.files.set(name, text);
    this._model = null;
  }

  removeFile(name) {
    this.files.delete(name);
    this._model = null;
  }

  isLibrary(name) {
    return this.libraries.has(name) && !this.files.has(name);
  }

  text(name) {
    return this.files.get(name) ?? this.libraries.get(name) ?? null;
  }

  get model() {
    if (!this._model) {
      const all = [...[...this.libraries].map(([name, text]) => ({ name, text })), ...[...this.files].map(([name, text]) => ({ name, text }))];
      this._model = buildModel(all, this.host);
      this._starts = new Map();
    }
    return this._model;
  }

  starts(name) {
    this.model;
    if (!this._starts.has(name)) this._starts.set(name, lineStarts(this.text(name) || ""));
    return this._starts.get(name);
  }

  tokens(name) {
    const text = this.text(name) || "";
    const cached = this._tokens.get(name);
    if (cached?.text === text) return cached.tokens;
    const tokens = tokenize(text, { operators: AADL_OPERATORS, annexBlocks: true });
    this._tokens.set(name, { text, tokens });
    return tokens;
  }

  range(name, offset, length) {
    const text = this.text(name) || "";
    const s = this.starts(name);
    return { start: positionAt(text, offset, s), end: positionAt(text, offset + length, s) };
  }

  locToRange(loc, length) {
    const text = this.text(loc.file) || "";
    const s = this.starts(loc.file);
    const pos = loc.pos ?? offsetAt(text, { line: loc.line - 1, character: loc.col - 1 }, s);
    return this.range(loc.file, pos, length);
  }

  // ---- structure lookups -----------------------------------------------------------------

  packageAt(name, offset) {
    return [...this.model.packages.values()].find((p) => p.file === name && p.loc.pos <= offset && offset <= (p.endPos ?? Infinity)) || null;
  }

  classifierAt(name, offset) {
    const pkg = this.packageAt(name, offset);
    return pkg?.classifiers.find((c) => c.startPos <= offset && offset <= (c.endPos ?? Infinity)) || null;
  }

  /** The section keyword (features, connections, …) governing `offset` inside a classifier. */
  sectionAt(name, offset, classifier) {
    if (!classifier) return null;
    const tokens = this.tokens(name);
    const text = this.text(name);
    let section = null;
    for (const t of tokens) {
      if (t.pos < classifier.startPos) continue;
      if (t.pos >= offset) break;
      if (t.type === "id" && SECTION_WORDS.has(t.lower)) {
        const lineStart = text.lastIndexOf("\n", t.pos - 1) + 1;
        if (!text.slice(lineStart, t.pos).trim()) section = t.lower;
      }
    }
    return section;
  }

  annexAt(name, offset) {
    for (const pkg of this.model.packages.values()) {
      if (pkg.file !== name) continue;
      const all = [...pkg.annexLibraries.map((a) => ({ annex: a, owner: null, pkg })), ...pkg.classifiers.flatMap((c) => c.annexes.map((a) => ({ annex: a, owner: c, pkg })))];
      for (const entry of all) {
        const a = entry.annex;
        if (a.bodyLoc && a.bodyLoc.pos <= offset && offset <= a.bodyEnd) return entry;
      }
    }
    return null;
  }

  visiblePackages(pkg) {
    const out = [];
    if (pkg) out.push(pkg);
    for (const w of pkg?.withs || []) {
      const p = this.model.findPackage(w.name);
      if (p) out.push(p);
    }
    return out;
  }

  // ---- name resolution ---------------------------------------------------------------------

  /** Token index at offset (an identifier containing or ending at offset). */
  tokenIndexAt(name, offset) {
    const tokens = this.tokens(name);
    let lo = 0, hi = tokens.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tokens[mid].end < offset) lo = mid + 1;
      else hi = mid;
    }
    for (const k of [lo, lo - 1, lo + 1]) {
      const t = tokens[k];
      if (t && (t.type === "id" || t.type === "annex") && t.pos <= offset && offset <= t.end) return k;
    }
    return -1;
  }

  /**
   * What the identifier at `offset` denotes. Returns a target
   * { key, kind, name, file, pos, length, detail } or null.
   */
  resolveAt(name, offset) {
    const tokens = this.tokens(name);
    const i = this.tokenIndexAt(name, offset);
    if (i < 0) return null;
    if (tokens[i].type === "annex") return this.resolveInAnnex(name, offset);
    return this.resolveToken(name, tokens, i);
  }

  resolveToken(name, tokens, i) {
    const model = this.model;
    const t = tokens[i];
    const isOp = (k, op) => tokens[k]?.type === "op" && tokens[k].value === op;
    const isKwAt = (k, w) => tokens[k]?.type === "id" && tokens[k].lower === w;
    // Assemble a qualified name A::B::C(.D) around token i.
    let s = i, e = i;
    while (isOp(s - 1, "::") && tokens[s - 2]?.type === "id") s -= 2;
    while (isOp(e + 1, "::") && tokens[e + 2]?.type === "id") e += 2;
    const qparts = [];
    for (let k = s; k <= e; k += 2) qparts.push(tokens[k]);
    const partIndex = (i - s) / 2;
    const hasDotAfter = isOp(e + 1, ".") && tokens[e + 2]?.type === "id";
    const hasDotBefore = isOp(s - 1, ".") && tokens[s - 2]?.type === "id";
    const prev = tokens[(hasDotBefore ? s - 2 : s) - 1];
    const next = tokens[(hasDotAfter ? e + 2 : e) + 1];
    const qname = qparts.map((p) => p.value).join("::");
    const pkg = this.packageAt(name, t.pos);
    const cls = this.classifierAt(name, t.pos);
    const section = this.sectionAt(name, t.pos, cls);

    // Package / property set part of a qualified name.
    if (partIndex < qparts.length - 1) {
      const head = qparts.slice(0, partIndex + 1).map((p) => p.value).join("::");
      return this.packageTarget(head);
    }
    // with clauses
    let k = s - 1;
    while (tokens[k] && (tokens[k].type === "id" || isOp(k, "::") || isOp(k, ","))) {
      if (isKwAt(k, "with") && (k === s - 1 || !isOp(k + 1, "::"))) return this.packageTarget(qname);
      if (tokens[k].type === "id" && !isOp(k + 1, "::") && !isOp(k + 1, ",") && k !== s - 1 && !isOp(k - 1, "::")) break;
      k--;
    }
    // package header / end
    if (isKwAt(s - 1, "package") || (isKwAt(s - 1, "end") && !cls && !hasDotAfter && !hasDotBefore)) {
      const p = this.model.findPackage(qname);
      if (p) return this.packageTarget(p.name);
    }
    if (isKwAt(s - 2, "property") && isKwAt(s - 1, "set")) return this.packageTarget(qname);

    // Property association name
    if (next && next.type === "op" && (next.value === "=>" || next.value === "+=>") && !hasDotBefore) {
      const found = model.propertyDefinition(qname);
      if (found) return this.defTarget(found);
    }

    // Property set declarations: `Name : ...` inside a property set
    const ps = [...model.propertySets.values()].find((p) => p.file === name && p.loc.pos <= t.pos && t.pos <= (p.endPos ?? Infinity));
    if (ps) {
      const own = ps.definitions.find((d) => lc(d.name) === t.lower);
      if (own) return this.defTarget({ set: ps, def: own });
      const found = model.propertyDefinition(qname) || model.propertyDefinition(`${ps.name}::${qname}`);
      if (found) return this.defTarget(found);
      const type = [...model.propertySets.values()].flatMap((p) => p.definitions.map((d) => ({ set: p, def: d }))).find((x) => x.def.isType && lc(x.def.name) === t.lower);
      return type ? this.defTarget(type) : null;
    }

    // Classifier names in headers and `end` lines: `A`, `A.impl`
    if (cls && (t.pos <= (cls.loc.pos + cls.name.length) && t.pos >= cls.loc.pos || isKwAt(s - 1, "end") || (hasDotBefore && isKwAt(s - 3, "end")))) {
      if (cls.kind === "componentImpl") {
        const [typePart] = cls.name.split(".");
        if (hasDotAfter || lc(t.value) === lc(typePart) && !hasDotBefore) return this.classifierTarget(cls._type || model.typeOf(cls));
        return this.classifierTarget(cls);
      }
      return this.classifierTarget(cls);
    }

    // Value positions inside a property association (enumeration literals, constants, references).
    const assocStart = this.assocStart(tokens, i);
    if (assocStart !== null) {
      const propTok = tokens[assocStart];
      let pname = propTok.value;
      if (isOp(assocStart + 1, "::")) pname += "::" + tokens[assocStart + 2].value;
      const found = model.propertyDefinition(pname);
      // reference (path) and applies-to paths resolve against the instance hierarchy of the classifier.
      const inPath = this.inParenAfter(tokens, i, "reference") || this.afterAppliesTo(tokens, i);
      if (inPath && cls) return this.resolvePath(cls, this.dottedPath(tokens, i), this.dottedIndex(tokens, i));
      if (qparts.length > 1 || !found) {
        const c = model.propertyDefinition(qname);
        if (c) return this.defTarget(c);
      }
      if (found) {
        const literalOwner = model.resolvedType(found.def);
        if (literalOwner?.enumLiterals?.some((l) => lc(l) === t.lower)) {
          const owner = [...model.propertySets.values()].find((p) => p.definitions.includes(literalOwner));
          return { ...this.defTarget({ set: owner, def: literalOwner }), kind: "enumLiteral", detail: `${t.value} — literal of ${owner.name}::${literalOwner.name}` };
        }
        const c = model.propertyDefinition(qname);
        if (c?.def.isConstant) return this.defTarget(c);
      }
      if (isKwAt(i - 2, "classifier")) {
        const c = this.lookupClassifier(this.classifierName(tokens, s, e), pkg);
        if (c) return this.classifierTarget(c, partIndex, hasDotBefore);
      }
    }

    // Member declarations: `name : ...`
    if (isOp(i + 1, ":") && !hasDotBefore && cls) {
      const member = this.memberNamed(cls, t.value, section);
      if (member) return this.memberTarget(member, cls);
    }

    // Classifier references: anything qualified, or after a category / extends / feature kind.
    const refLike = qparts.length > 1 || isKwAt(s - 1, "extends") || this.afterCategoryWord(tokens, s) ||
      isKwAt(s - 1, "port") || isKwAt(s - 1, "access") || isKwAt(s - 1, "parameter") || isKwAt(s - 1, "group") && section === "features";
    if (refLike && (section !== "connections" && section !== "flows")) {
      const c = this.lookupClassifier(this.classifierName(tokens, s, e), pkg, hasDotBefore ? tokens[s - 2].value : null);
      if (c) {
        if (hasDotBefore) return this.classifierTarget(c);
        if (hasDotAfter && c.kind === "componentImpl") return this.classifierTarget(model.typeOf(c));
        return this.classifierTarget(c);
      }
    }

    // Connection ends, flow segments: `sub.feature`, `feature`, `connection`.
    if (cls && (section === "connections" || section === "flows" || section === "calls")) {
      return this.resolvePath(cls, this.dottedPath(tokens, i), this.dottedIndex(tokens, i));
    }
    return null;
  }

  assocStart(tokens, i) {
    // Walk back to the start of the statement; it is an association if `name =>` begins it.
    let k = i;
    let depth = 0;
    while (k > 0) {
      const t = tokens[k - 1];
      if (t.type === "op" && (t.value === ";" || t.value === "{")) {
        if (t.value === "{" && depth === 0) break;
        if (t.value === ";" && depth === 0) break;
      }
      if (t.type === "op" && (t.value === ")" || t.value === "]")) depth++;
      if (t.type === "op" && (t.value === "(" || t.value === "[")) depth--;
      if (t.type === "id" && SECTION_WORDS.has(t.lower)) break;
      k--;
    }
    const first = tokens[k];
    if (!first || first.type !== "id") return null;
    const arrow = tokens[k + 1]?.value === "::" ? tokens[k + 3] : tokens[k + 1];
    if (!arrow || arrow.type !== "op" || (arrow.value !== "=>" && arrow.value !== "+=>")) return null;
    return k === i ? null : k;
  }

  inParenAfter(tokens, i, word) {
    let k = i - 1;
    while (k >= 0 && tokens[k].type === "id" || tokens[k]?.value === ".") k--;
    return tokens[k]?.value === "(" && tokens[k - 1]?.type === "id" && tokens[k - 1].lower === word;
  }

  afterAppliesTo(tokens, i) {
    for (let k = i - 1; k > 0 && k > i - 40; k--) {
      const t = tokens[k];
      if (t.type === "op" && t.value === ";") return false;
      if (t.type === "id" && t.lower === "to" && tokens[k - 1]?.lower === "applies") return true;
    }
    return false;
  }

  dottedPath(tokens, i) {
    let s = i, e = i;
    while (tokens[s - 1]?.value === "." && tokens[s - 2]?.type === "id") s -= 2;
    while (tokens[e + 1]?.value === "." && tokens[e + 2]?.type === "id") e += 2;
    const parts = [];
    for (let k = s; k <= e; k += 2) parts.push(tokens[k].value);
    return parts;
  }

  dottedIndex(tokens, i) {
    let n = 0;
    for (let k = i; tokens[k - 1]?.value === "." && tokens[k - 2]?.type === "id"; k -= 2) n++;
    return n;
  }

  afterCategoryWord(tokens, s) {
    const p1 = tokens[s - 1], p2 = tokens[s - 2];
    if (p1?.type !== "id") return false;
    if (CATEGORIES.includes(p1.lower)) return tokens[s - 2]?.value === ":" || CATEGORIES.includes(`${p2?.lower} ${p1.lower}`) || p2?.value === ":";
    return CATEGORIES.includes(`${p2?.lower} ${p1.lower}`);
  }

  classifierName(tokens, s, e) {
    let n = [];
    for (let k = s; k <= e; k += 2) n.push(tokens[k].value);
    let name = n.join("::");
    if (tokens[e + 1]?.value === "." && tokens[e + 2]?.type === "id") name += "." + tokens[e + 2].value;
    if (tokens[s - 1]?.value === "." && tokens[s - 2]?.type === "id") {
      // implementation part: rebuild from the type part
      let ts = s - 2, parts = [tokens[ts].value];
      while (tokens[ts - 1]?.value === "::" && tokens[ts - 2]?.type === "id") {
        ts -= 2;
        parts.unshift(tokens[ts].value);
      }
      name = `${parts.join("::")}.${tokens[s].value}`;
    }
    return name;
  }

  lookupClassifier(ref, pkg) {
    if (!pkg) return this.model.findByQualifiedName(ref);
    return this.model.resolveClassifier(ref, pkg.name) || (ref.includes("::") ? this.model.findByQualifiedName(ref) : null);
  }

  memberNamed(cls, name, section) {
    const n = lc(name);
    const groups = {
      features: cls.features, flows: cls.flows, subcomponents: cls.subcomponents, connections: cls.connections,
    };
    const list = groups[section] || [...(cls.features || []), ...(cls.subcomponents || []), ...(cls.connections || []), ...(cls.flows || [])];
    return list?.find((m) => lc(m.name) === n) || null;
  }

  /** Resolve `a.b.c` inside an implementation: subcomponent → feature / flow spec, or own members. */
  resolvePath(cls, parts, index) {
    const model = this.model;
    let ctx = cls;
    for (let k = 0; k <= index; k++) {
      const part = lc(parts[k]);
      const last = k === index;
      const sub = (ctx.kind === "componentImpl" ? model.allSubcomponents(ctx) : []).find((x) => lc(x.name) === part);
      if (sub) {
        if (last) return this.memberTarget(sub, ctx);
        ctx = sub._classifier;
        if (!ctx) return null;
        continue;
      }
      const feature = model.allFeatures(ctx).find((f) => lc(f.name) === part);
      if (feature) return last ? this.memberTarget(feature, model.typeOf(ctx)) : null;
      const flow = model.allFlowSpecs(ctx).find((f) => lc(f.name) === part);
      if (flow && last) return this.memberTarget(flow, model.typeOf(ctx));
      if (k === 0) {
        const conn = model.allConnections(cls).find((c) => lc(c.name) === part) || model.allFlowImpls(cls).find((f) => lc(f.name) === part);
        if (conn && last) return this.memberTarget(conn, cls);
      }
      return null;
    }
    return null;
  }

  // ---- targets ---------------------------------------------------------------------------

  packageTarget(qname) {
    const p = this.model.findPackage(qname);
    if (p) return { key: `pkg:${lc(p.name)}`, kind: "package", name: p.name, file: p.file, pos: p.nameLoc.pos, length: p.name.length, detail: `package ${p.name}`, decl: p };
    const ps = this.model.propertySets.get(lc(qname));
    if (ps) return { key: `ps:${lc(ps.name)}`, kind: "propertySet", name: ps.name, file: ps.file, pos: ps.nameLoc.pos, length: ps.name.length, detail: `property set ${ps.name}`, decl: ps };
    return null;
  }

  classifierTarget(c) {
    if (!c) return null;
    const kindWord = c.kind === "componentImpl" ? `${c.category} implementation` : c.category;
    const file = this.model.findPackage(c.pkg)?.file;
    return { key: `cls:${lc(c.pkg)}::${lc(c.name)}`, kind: "classifier", name: c.name, file, pos: c.loc.pos, length: c.kind === "componentImpl" ? c.name.length : c.name.length, detail: `${kindWord} ${c.pkg}::${c.name}`, decl: c };
  }

  memberTarget(m, owner) {
    const file = owner ? this.model.findPackage(owner.pkg)?.file : m.loc.file;
    let detail = m.name;
    if (m.kind === "feature") detail = `${m.name}: ${[m.access, m.direction, m.featureKind].filter(Boolean).join(" ")}${m.classifier ? " " + m.classifier.name : ""}`;
    else if (m.kind === "subcomponent") detail = `${m.name}: ${m.category}${m.classifier ? " " + m.classifier.name : ""}`;
    else if (m.kind === "connection") detail = `${m.name}: ${m.connectionKind} ${m.src.context ? m.src.context + "." : ""}${m.src.feature} ${m.bidirectional ? "<->" : "->"} ${m.dst.context ? m.dst.context + "." : ""}${m.dst.feature}`;
    else if (m.kind === "flowSpec") detail = `${m.name}: flow ${m.flowKind}${m.in ? " " + m.in : ""}${m.out ? " -> " + m.out : ""}`;
    else if (m.kind === "flowImpl") detail = `${m.name}: ${m.flowKind} flow ${m.segments.join(" -> ")}`;
    return { key: `mem:${m.loc.file}:${m.loc.pos}`, kind: m.kind, name: m.name, file: file || m.loc.file, pos: m.loc.pos, length: m.name.length, detail: owner ? `${detail}  (in ${owner.pkg}::${owner.name})` : detail, decl: m };
  }

  defTarget({ set, def }) {
    const what = def.isType ? "type" : def.isConstant ? "constant" : "property";
    const applies = def.appliesTo.length ? ` applies to (${def.appliesTo.join(", ")})` : "";
    return { key: `def:${lc(set.name)}::${lc(def.name)}`, kind: what, name: def.name, file: set.file, pos: def.loc.pos, length: def.name.length, detail: `${what} ${set.name}::${def.name} : ${def.typeText}${applies}`, decl: def, set };
  }

  // ---- annexes ------------------------------------------------------------------------------

  annexTokens(name, annex) {
    const text = this.text(name);
    const body = text.slice(annex.bodyLoc.pos, annex.bodyEnd);
    return tokenize(body, { operators: AGREE_OPS }).map((t) => ({ ...t, pos: t.pos + annex.bodyLoc.pos, end: t.end + annex.bodyLoc.pos, lower: t.type === "id" ? t.value.toLowerCase() : t.value }));
  }

  resolveInAnnex(name, offset) {
    const entry = this.annexAt(name, offset);
    if (!entry) return null;
    const tokens = this.annexTokens(name, entry.annex);
    const i = tokens.findIndex((t) => t.type === "id" && t.pos <= offset && offset <= t.end);
    if (i < 0) return null;
    return this.resolveAnnexToken(name, entry, tokens, i);
  }

  resolveAnnexToken(name, entry, tokens, i) {
    const model = this.model;
    const t = tokens[i];
    const cls = entry.owner;
    // Qualified library references: Pkg::NAME
    if (tokens[i - 1]?.value === "::" && tokens[i - 2]?.type === "id") {
      const lib = model.annexLibraries(entry.annex.lname).find(({ pkg }) => lc(pkg.name) === tokens[i - 2].lower);
      const spec = lib?.annex.parsed?.specs?.find((sp) => lc(sp.name) === t.lower);
      if (spec) return { key: `annex:${lc(lib.pkg.name)}::${t.lower}`, kind: "annexDecl", name: spec.name, file: lib.pkg.file, pos: this.specNamePos(lib.pkg.file, spec), length: spec.name.length, detail: `${spec.kind} ${lib.pkg.name}::${spec.name}`, decl: spec };
      return null;
    }
    if (tokens[i + 1]?.value === "::") return this.packageTarget(t.value);
    if (!cls) return null;
    if (tokens[i - 1]?.value === "." && tokens[i - 2]?.type === "id") {
      return this.resolvePath(cls.kind === "componentImpl" ? cls : cls, [tokens[i - 2].value, t.value], 1);
    }
    // eq / const declared in an AGREE subclause of this classifier (type or implementation)
    for (const { annex, owner } of model.annexSubclauses(cls, entry.annex.lname)) {
      for (const sp of annex.parsed?.specs || []) {
        for (const v of sp.vars || []) {
          if (lc(v.name) === t.lower) return { key: `annex:${v.loc.file}:${v.loc.line}:${lc(v.name)}`, kind: "annexDecl", name: v.name, file: this.model.findPackage(owner.pkg)?.file, pos: this.posOf(v.loc), length: v.name.length, detail: `eq ${v.name} : ${v.type.name}`, decl: v };
        }
        if ((sp.kind === "const" || sp.kind === "property" || sp.kind === "node" || sp.kind === "fun") && lc(sp.name) === t.lower) {
          const file = this.model.findPackage(owner.pkg)?.file;
          return { key: `annex:${file}:${lc(sp.name)}`, kind: "annexDecl", name: sp.name, file, pos: this.specNamePos(file, sp), length: sp.name.length, detail: `${sp.kind} ${sp.name}`, decl: sp };
        }
      }
    }
    if (cls.kind === "componentImpl") {
      const sub = model.allSubcomponents(cls).find((x) => lc(x.name) === t.lower);
      if (sub) return this.memberTarget(sub, cls);
    }
    const f = model.allFeatures(cls).find((x) => lc(x.name) === t.lower);
    if (f) return this.memberTarget(f, model.typeOf(cls));
    const lib = model.annexLibraries(entry.annex.lname).map(({ annex, pkg }) => ({ pkg, spec: annex.parsed?.specs?.find((sp) => lc(sp.name) === t.lower) })).find((x) => x.spec);
    if (lib) return { key: `annex:${lc(lib.pkg.name)}::${t.lower}`, kind: "annexDecl", name: lib.spec.name, file: lib.pkg.file, pos: this.specNamePos(lib.pkg.file, lib.spec), length: lib.spec.name.length, detail: `${lib.spec.kind} ${lib.pkg.name}::${lib.spec.name}`, decl: lib.spec };
    return null;
  }

  posOf(loc) {
    const text = this.text(loc.file) || "";
    return offsetAt(text, { line: loc.line - 1, character: loc.col - 1 }, this.starts(loc.file));
  }

  specNamePos(file, spec) {
    const text = this.text(file) || "";
    const from = this.posOf({ ...spec.loc, file });
    const at = text.toLowerCase().indexOf(spec.name.toLowerCase(), from);
    return at >= 0 ? at : from;
  }

  // ---- LSP features ----------------------------------------------------------------------------

  definition(uri, position) {
    const name = nameOf(uri);
    const text = this.text(name);
    if (text === null) return null;
    const target = this.resolveAt(name, offsetAt(text, position, this.starts(name)));
    if (!target?.file) return null;
    return { uri: uriOf(target.file), range: this.range(target.file, target.pos, target.length) };
  }

  hover(uri, position) {
    const name = nameOf(uri);
    const text = this.text(name);
    if (text === null) return null;
    const offset = offsetAt(text, position, this.starts(name));
    const target = this.resolveAt(name, offset);
    if (!target) return null;
    const lines = ["```aadl", target.detail, "```"];
    if (target.kind === "classifier") {
      const c = target.decl;
      const counts = [];
      if (this.model.allFeatures(c).length) counts.push(`${this.model.allFeatures(c).length} features`);
      if (c.kind === "componentImpl") {
        counts.push(`${this.model.allSubcomponents(c).length} subcomponents`, `${this.model.allConnections(c).length} connections`);
      }
      if (counts.length) lines.push(counts.join(" · "));
    }
    if (target.kind === "property" || target.kind === "type") {
      const literals = this.model.enumLiteralsOf(target.decl);
      const units = this.model.unitsOf(target.decl);
      if (literals.length) lines.push(`Values: ${literals.join(", ")}`);
      if (units.length) lines.push(`Units: ${units.join(", ")}`);
    }
    lines.push(`*${target.file}*`);
    const i = this.tokenIndexAt(name, offset);
    const tok = this.tokens(name)[i];
    const range = tok && tok.type === "id" ? this.range(name, tok.pos, tok.end - tok.pos) : undefined;
    return { contents: { kind: "markdown", value: lines.join("\n") }, range };
  }

  /** Every occurrence (declaration included when asked) that resolves to the same target. */
  references(uri, position, { includeDeclaration = true } = {}) {
    const name = nameOf(uri);
    const text = this.text(name);
    if (text === null) return [];
    const target = this.resolveAt(name, offsetAt(text, position, this.starts(name)));
    if (!target) return [];
    return this.occurrences(target, { includeDeclaration }).map((o) => ({ uri: uriOf(o.file), range: this.range(o.file, o.pos, o.length) }));
  }

  occurrences(target, { includeDeclaration = true } = {}) {
    const out = [];
    const short = lc(target.name.split(".").pop());
    const typePart = lc(target.name.split(".")[0]);
    const files = [...this.libraries.keys(), ...this.files.keys()];
    for (const file of new Set(files)) {
      const tokens = this.tokens(file);
      for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.type === "annex") {
          if (!(this.text(file).slice(t.pos, t.end).toLowerCase().includes(short))) continue;
          const entry = this.annexAt(file, t.pos + 3);
          if (!entry) continue;
          const atoks = this.annexTokens(file, entry.annex);
          for (let j = 0; j < atoks.length; j++) {
            if (atoks[j].type !== "id" || atoks[j].lower !== short) continue;
            const r = this.resolveAnnexToken(file, entry, atoks, j);
            if (r?.key === target.key) out.push({ file, pos: atoks[j].pos, length: atoks[j].end - atoks[j].pos });
          }
          continue;
        }
        if (t.type !== "id" || (t.lower !== short && t.lower !== typePart)) continue;
        const r = this.resolveToken(file, tokens, i);
        if (r?.key === target.key) out.push({ file, pos: t.pos, length: t.end - t.pos });
      }
    }
    const isDecl = (o) => o.file === target.file && o.pos === target.pos;
    if (includeDeclaration && target.file && !out.some(isDecl)) out.unshift({ file: target.file, pos: target.pos, length: target.length });
    return includeDeclaration ? out : out.filter((o) => !isDecl(o));
  }

  prepareRename(uri, position) {
    const name = nameOf(uri);
    const text = this.text(name);
    if (text === null) return null;
    const offset = offsetAt(text, position, this.starts(name));
    const target = this.resolveAt(name, offset);
    if (!target || this.isLibrary(target.file)) return null;
    const tok = this.tokens(name)[this.tokenIndexAt(name, offset)];
    if (!tok || tok.type !== "id") {
      const atok = this.annexAt(name, offset) && this.annexTokens(name, this.annexAt(name, offset).annex).find((x) => x.pos <= offset && offset <= x.end);
      return atok ? { range: this.range(name, atok.pos, atok.end - atok.pos), placeholder: atok.value } : null;
    }
    return { range: this.range(name, tok.pos, tok.end - tok.pos), placeholder: tok.value };
  }

  rename(uri, position, newName) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(newName)) throw new Error(`'${newName}' is not a valid AADL identifier`);
    const name = nameOf(uri);
    const text = this.text(name);
    const offset = offsetAt(text, position, this.starts(name));
    const target = this.resolveAt(name, offset);
    if (!target) return null;
    if (this.isLibrary(target.file)) throw new Error(`'${target.name}' is declared in the read-only library ${target.file}`);
    const renamingTypePart = target.kind === "classifier" && target.name.includes(".");
    const changes = {};
    for (const o of this.occurrences(target)) {
      if (this.isLibrary(o.file)) continue;
      const word = this.text(o.file).slice(o.pos, o.pos + o.length);
      // For implementations only the part after '.' is renamed.
      const { pos, length } = o;
      if (renamingTypePart && lc(word) !== lc(target.name.split(".").pop())) continue;
      (changes[uriOf(o.file)] ||= []).push({ range: this.range(o.file, pos, length), newText: newName });
    }
    return { changes };
  }

  documentSymbols(uri) {
    const name = nameOf(uri);
    const out = [];
    const sym = (n, kind, startPos, endPos, selPos, selLen, detail, children) => ({
      name: n, kind, detail, range: this.range(name, startPos, Math.max(selLen, endPos - startPos)), selectionRange: this.range(name, selPos, selLen), children,
    });
    for (const pkg of this.model.packages.values()) {
      if (pkg.file !== name) continue;
      const children = pkg.classifiers.map((c) => {
        const members = [
          ...(c.features || []).map((m) => sym(m.name, SymbolKind.Field, m.loc.pos, m.loc.pos + m.name.length, m.loc.pos, m.name.length, [m.direction, m.featureKind].filter(Boolean).join(" "))),
          ...(c.subcomponents || []).map((m) => sym(m.name, SymbolKind.Variable, m.loc.pos, m.loc.pos + m.name.length, m.loc.pos, m.name.length, m.category)),
          ...(c.connections || []).map((m) => sym(m.name, SymbolKind.Event, m.loc.pos, m.loc.pos + m.name.length, m.loc.pos, m.name.length, m.connectionKind)),
          ...(c.flows || []).map((m) => sym(m.name, SymbolKind.Function, m.loc.pos, m.loc.pos + m.name.length, m.loc.pos, m.name.length, `flow ${m.flowKind}`)),
        ];
        return sym(c.name, c.kind === "componentImpl" ? SymbolKind.Class : SymbolKind.Interface, c.startPos, c.endPos ?? c.loc.pos, c.loc.pos, c.name.length, c.kind === "componentImpl" ? `${c.category} implementation` : c.category, members);
      });
      out.push(sym(pkg.name, SymbolKind.Package, pkg.loc.pos, pkg.endPos ?? pkg.loc.pos, pkg.nameLoc.pos, pkg.name.length, "package", children));
    }
    for (const ps of this.model.propertySets.values()) {
      if (ps.file !== name) continue;
      out.push(sym(ps.name, SymbolKind.Namespace, ps.loc.pos, ps.endPos ?? ps.loc.pos, ps.nameLoc.pos, ps.name.length, "property set",
        ps.definitions.map((d) => sym(d.name, d.isType ? SymbolKind.Struct : d.isConstant ? SymbolKind.Constant : SymbolKind.Property, d.loc.pos, d.loc.pos + d.name.length, d.loc.pos, d.name.length, d.typeText))));
    }
    return out;
  }

  foldingRanges(uri) {
    const name = nameOf(uri);
    const text = this.text(name) || "";
    const s = this.starts(name);
    const line = (pos) => positionAt(text, pos, s).line;
    const out = [];
    const add = (a, b, kind) => {
      if (b > a) out.push({ startLine: a, endLine: b, kind });
    };
    for (const pkg of this.model.packages.values()) {
      if (pkg.file !== name) continue;
      add(line(pkg.loc.pos), line(pkg.endPos ?? pkg.loc.pos) - 1);
      for (const c of pkg.classifiers) {
        add(line(c.startPos), line(c.endPos ?? c.startPos) - 1);
        for (const a of c.annexes) if (a.bodyLoc) add(line(a.loc.pos), line(a.bodyEnd));
      }
      for (const a of pkg.annexLibraries) if (a.bodyLoc) add(line(a.loc.pos), line(a.bodyEnd));
    }
    for (const ps of this.model.propertySets.values()) if (ps.file === name) add(line(ps.loc.pos), line(ps.endPos ?? ps.loc.pos) - 1);
    // Sections inside classifiers: from the section keyword to the line before the next section / end.
    const lines = text.split("\n");
    let sectionStart = -1;
    for (let k = 0; k < lines.length; k++) {
      const w = lines[k].trim().split(/\s+/)[0]?.toLowerCase();
      const closes = SECTION_WORDS.has(w) || w === "end";
      if (closes && sectionStart >= 0) {
        add(sectionStart, k - 1);
        sectionStart = -1;
      }
      if (SECTION_WORDS.has(w) && w !== "annex" && lines[k].trim().split(/\s+/).length === 1) sectionStart = k;
    }
    // Consecutive comment lines.
    let commentStart = -1;
    for (let k = 0; k <= lines.length; k++) {
      const isComment = k < lines.length && lines[k].trim().startsWith("--");
      if (isComment && commentStart < 0) commentStart = k;
      if (!isComment && commentStart >= 0) {
        if (k - 1 > commentStart) add(commentStart, k - 1, "comment");
        commentStart = -1;
      }
    }
    return out;
  }

  diagnostics(uri) {
    const name = nameOf(uri);
    const text = this.text(name) || "";
    const s = this.starts(name);
    return this.model.diagnostics.filter((d) => d.file === name).map((d) => {
      const start = { line: Math.max(0, d.line - 1), character: Math.max(0, (d.col || 1) - 1) };
      const off = offsetAt(text, start, s);
      const m = /^[\w:.]+/.exec(text.slice(off));
      const end = positionAt(text, off + Math.max(1, m ? m[0].length : 1), s);
      return { range: { start, end }, severity: Severity[d.severity] || 3, source: d.source || "aadl", message: d.message };
    });
  }

  // ---- completion --------------------------------------------------------------------------------

  completion(uri, position) {
    const name = nameOf(uri);
    const text = this.text(name);
    if (text === null) return { isIncomplete: false, items: [] };
    const offset = offsetAt(text, position, this.starts(name));
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const before = text.slice(lineStart, offset);
    const items = this.completionItems(name, offset, before);
    const seen = new Set();
    return { isIncomplete: false, items: items.filter((it) => !seen.has(it.label) && seen.add(it.label)) };
  }

  completionItems(name, offset, before) {
    const model = this.model;
    const annex = this.annexAt(name, offset);
    if (annex) return this.annexCompletion(annex, before);
    const pkg = this.packageAt(name, offset);
    const cls = this.classifierAt(name, offset);
    const section = this.sectionAt(name, offset, cls);
    let m;

    if (/^\s*--/.test(before)) return [];
    if ((m = /\bwith\s+(?:[\w:]+\s*,\s*)*([\w]*)$/i.exec(before))) {
      return [
        ...[...model.packages.values()].filter((p) => p !== pkg).map((p) => ({ label: p.name, kind: CompletionItemKind.Module, detail: "package" })),
        ...[...model.propertySets.values()].map((p) => ({ label: p.name, kind: CompletionItemKind.Folder, detail: "property set" })),
      ];
    }
    // Property value completion: `Name => <here>`
    if ((m = /^\s*([\w]+(?:::\w+)?)\s*\+?=>\s*(?:constant\s+)?(.*)$/i.exec(before))) {
      const found = model.propertyDefinition(m[1]);
      return found ? this.valueCompletion(found, m[2], cls) : [];
    }
    if ((m = /(\w+)::(\w*)$/.exec(before))) {
      const q = m[1];
      const p = model.findPackage(q);
      if (p) {
        const wanted = this.wantedCategory(before, section);
        return p.classifiers.filter((c) => c.visibility !== "private" && (!wanted || c.category === wanted || c.category === "abstract"))
          .map((c) => ({ label: c.name, kind: c.kind === "componentImpl" ? CompletionItemKind.Class : CompletionItemKind.Interface, detail: c.kind === "componentImpl" ? `${c.category} implementation` : c.category }));
      }
      const ps = model.propertySets.get(lc(q));
      if (ps) {
        return ps.definitions.filter((d) => !d.isType || section !== "properties").map((d) => ({ label: d.name, kind: d.isType ? CompletionItemKind.Struct : d.isConstant ? CompletionItemKind.Constant : CompletionItemKind.Property, detail: d.typeText, insertText: !d.isType && !d.isConstant && section === "properties" ? `${d.name} => ` : d.name }));
      }
      return [];
    }
    // sub.feature in connections / flows / applies-to
    if ((m = /(\w+)\.(\w*)$/.exec(before)) && cls?.kind === "componentImpl") {
      const sub = model.allSubcomponents(cls).find((x) => lc(x.name) === lc(m[1]));
      if (sub?._classifier) {
        return [
          ...model.allFeatures(sub._classifier).map((f) => ({ label: f.name, kind: CompletionItemKind.Field, detail: [f.direction, f.featureKind, f.classifier?.name].filter(Boolean).join(" ") })),
          ...(section === "flows" ? model.allFlowSpecs(sub._classifier).map((f) => ({ label: f.name, kind: CompletionItemKind.Function, detail: `flow ${f.flowKind}` })) : []),
        ];
      }
    }
    if (!pkg) {
      return [
        snippet("package", "package ${1:Name}\npublic\n  with Base_Types;\n\n  $0\nend ${1:Name};\n", "New package"),
        snippet("property set", "property set ${1:Name} is\n  ${2:My_Property}: aadlinteger applies to (all);\nend ${1:Name};\n", "New property set"),
      ];
    }
    if (!cls) return this.packageLevelCompletion(pkg);
    return this.classifierCompletion(name, offset, before, pkg, cls, section);
  }

  wantedCategory(before, section) {
    const m = /:\s*(?:refined\s+to\s+)?((?:thread|virtual|subprogram)\s+(?:group|processor|bus)|\w+)\s+[\w:]*$/i.exec(before);
    if (section === "subcomponents" && m && CATEGORIES.includes(lc(m[1]))) return lc(m[1]);
    if (section === "features" && /\b(port|parameter)\s+[\w:]*$/i.test(before)) return "data";
    if (section === "features" && /\b(data|bus|subprogram|virtual bus)\s+access\s+[\w:]*$/i.test(before)) return lc(/\b(data|bus|subprogram|virtual bus)\s+access/i.exec(before)[1]);
    return null;
  }

  classifierItems(pkg, category) {
    const items = [];
    for (const p of this.visiblePackages(pkg)) {
      for (const c of p.classifiers) {
        if (category && c.category !== category && c.category !== "abstract") continue;
        if (p !== pkg && c.visibility === "private") continue;
        const label = p === pkg ? c.name : `${p.name}::${c.name}`;
        items.push({ label, kind: c.kind === "componentImpl" ? CompletionItemKind.Class : CompletionItemKind.Interface, detail: c.kind === "componentImpl" ? `${c.category} implementation` : c.category, sortText: p === pkg ? `0${label}` : `1${label}` });
      }
    }
    return items;
  }

  packageLevelCompletion(pkg) {
    const out = [kw("public"), kw("private"), kw("with"), kw("properties"), { label: `end ${pkg.name};`, kind: CompletionItemKind.Keyword, detail: "close package" }];
    for (const cat of CATEGORIES) {
      out.push(snippet(`${cat} type`, `${cat} \${1:Name}\n  features\n    \${2:input}: in data port Base_Types::Integer;\nend \${1:Name};\n$0`, `New ${cat} type`));
      out.push(snippet(`${cat} implementation`, `${cat} implementation \${1:Name}.\${2:impl}\n  subcomponents\n    $0\nend \${1:Name}.\${2:impl};\n`, `New ${cat} implementation`));
    }
    out.push(snippet("annex agree library", "annex agree {**\n  const ${1:MAX} : int = ${2:10};\n**};\n", "AGREE annex library"));
    return out;
  }

  classifierCompletion(name, offset, before, pkg, cls, section) {
    const model = this.model;
    const sections = cls.kind === "componentImpl" ? IMPL_SECTIONS : TYPE_SECTIONS;
    const sectionItems = () => [
      ...sections.filter((s) => s !== "requires" && s !== "internal").map((s) => kw(s, "section")),
      { label: `end ${cls.name};`, kind: CompletionItemKind.Keyword, detail: "close classifier" },
      snippet("annex agree", "annex agree {**\n  ${1:guarantee \"${2:description}\" : ${3:true};}\n**};", "AGREE subclause"),
      snippet("annex EMV2", "annex EMV2 {**\n  use types ErrorLibrary;\n  error propagations\n    ${1:output}: out propagation {ServiceOmission};\n  end propagations;\n**};", "Error Model subclause"),
      snippet("annex behavior_specification", "annex behavior_specification {**\n  states\n    s0 : initial complete state;\n  transitions\n    t0 : s0 -[ on dispatch ]-> s0 { ${1:skip} };\n**};", "Behavior Annex subclause"),
    ];
    const wanted = this.wantedCategory(before, section);
    if (wanted) return this.classifierItems(pkg, wanted);
    if (section === "properties" || /^\s*[\w:]*$/.test(before) && section === "properties") {
      if (/^\s*[\w:]*$/.test(before)) return [...this.propertyNameItems(pkg, cls), ...sectionItems()];
    }
    if (/^\s*[\w:]*$/.test(before)) {
      // start of a line: section keywords plus nothing else known
      return sectionItems();
    }
    if (section === "features") {
      if (/:\s*(?:refined\s+to\s+)?$/i.test(before)) {
        return [
          ...["in data port", "out data port", "in out data port", "in event port", "out event port", "in event data port", "out event data port", "in out event data port", "requires data access", "provides data access", "requires bus access", "provides bus access", "requires subprogram access", "provides subprogram access", "feature group", "in parameter", "out parameter", "feature"].map((k) => kw(k, "feature")),
        ];
      }
    }
    if (section === "subcomponents" && /:\s*(?:refined\s+to\s+)?$/i.test(before)) return CATEGORIES.map((c) => kw(c, "category"));
    if (section === "connections") {
      if (/:\s*(?:refined\s+to\s+)?$/i.test(before)) return ["port", "feature", "feature group", "parameter", "bus access", "data access", "subprogram access"].map((k) => kw(k, "connection kind"));
      if (/(?:port|access|feature|group|parameter|->|<->)\s+\w*$/i.test(before)) return this.endpointItems(cls);
    }
    if (section === "flows") {
      if (/:\s*$/.test(before)) return cls.kind === "componentImpl" ? [kw("end to end flow"), kw("flow path"), kw("flow source"), kw("flow sink")] : [kw("flow source"), kw("flow sink"), kw("flow path")];
      if (/(?:flow|->)\s+\w*$/i.test(before) || /(?:source|sink|path)\s+\w*$/i.test(before)) {
        return [...this.endpointItems(cls), ...model.allConnections(cls).map((c) => ({ label: c.name, kind: CompletionItemKind.Event, detail: "connection" }))];
      }
    }
    if (/applies\s+to\s+[\w.,\s]*$/i.test(before)) return this.endpointItems(cls);
    return [];
  }

  endpointItems(cls) {
    const model = this.model;
    return [
      ...model.allFeatures(cls).map((f) => ({ label: f.name, kind: CompletionItemKind.Field, detail: [f.direction, f.featureKind].filter(Boolean).join(" ") })),
      ...model.allSubcomponents(cls).map((s) => ({ label: s.name, kind: CompletionItemKind.Variable, detail: `${s.category}${s.classifier ? " " + s.classifier.name : ""}`, commitCharacters: ["."] })),
      ...model.allSubcomponents(cls).flatMap((s) => (s._classifier ? model.allFeatures(s._classifier).map((f) => ({ label: `${s.name}.${f.name}`, kind: CompletionItemKind.Field, detail: [f.direction, f.featureKind].filter(Boolean).join(" "), sortText: `z${s.name}.${f.name}` })) : [])),
    ];
  }

  propertyNameItems(pkg, cls) {
    const model = this.model;
    const category = cls?.category;
    const applies = (def) => !category || !def.appliesTo.length || def.appliesTo.includes("all") || def.appliesTo.some((a) => a === category || category.startsWith(a) || a === "component" || a.includes("classifier"));
    const items = [];
    for (const setName of PREDECLARED_SETS) {
      const set = model.propertySets.get(lc(setName));
      for (const d of set?.definitions || []) {
        if (d.isType || d.isConstant || !applies(d)) continue;
        items.push({ label: d.name, kind: CompletionItemKind.Property, detail: `${set.name}::${d.name} : ${d.typeText}`, insertText: `${d.name} => `, sortText: `0${d.name}` });
      }
    }
    for (const w of pkg?.withs || []) {
      const set = model.propertySets.get(lc(w.name));
      if (!set || PREDECLARED_SETS.some((s) => lc(s) === lc(set.name))) continue;
      for (const d of set.definitions) {
        if (d.isType || d.isConstant || !applies(d)) continue;
        items.push({ label: `${set.name}::${d.name}`, kind: CompletionItemKind.Property, detail: d.typeText, insertText: `${set.name}::${d.name} => `, sortText: `1${set.name}::${d.name}` });
      }
    }
    return items;
  }

  valueCompletion({ def }, typed, cls) {
    const model = this.model;
    const items = [];
    const literals = model.enumLiteralsOf(def);
    for (const l of literals) items.push({ label: l, kind: CompletionItemKind.EnumMember, detail: `${def.name} value` });
    const units = model.unitsOf(def);
    if (units.length && /\d\s+\w*$/.test(typed)) return units.map((u) => ({ label: u, kind: CompletionItemKind.Unit, detail: "unit" }));
    const t = model.resolvedType(def)?.typeText || def.typeText || "";
    if (/aadlboolean/i.test(t)) items.push({ label: "true", kind: CompletionItemKind.Value }, { label: "false", kind: CompletionItemKind.Value });
    if (/reference/i.test(t)) {
      items.push(snippet("reference (…)", "reference (${1:target})", "reference value", CompletionItemKind.Reference));
      if (cls?.kind === "componentImpl" && /reference\s*\(\s*\w*$/i.test(typed)) return this.endpointItems(cls);
    }
    if (/classifier/i.test(t)) items.push(snippet("classifier (…)", "classifier (${1:Pkg::Name})", "classifier value", CompletionItemKind.Reference));
    if (/range of|\.\./i.test(t) || /Time_Range|Size_Range/i.test(t)) items.push(snippet("min .. max", "${1:0} ${2:ms} .. ${3:1} ${2:ms}", "range", CompletionItemKind.Value));
    if (/applies\s+to\s*\w*$/i.test(typed) || /;\s*$/.test(typed)) return items;
    items.push(snippet("applies to", "applies to ${1:subcomponent}", "contained property association", CompletionItemKind.Keyword));
    return items;
  }

  annexCompletion(entry, before) {
    const model = this.model;
    const cls = entry.owner;
    const lname = entry.annex.lname;
    let m;
    const keywords = (this.host?.annexHandler(lname) && this.host.active.find((p) => p.annexes && Object.keys(p.annexes).some((k) => lc(k) === lname))?.editorKeywords) || [];
    if ((m = /(\w+)::(\w*)$/.exec(before))) {
      const lib = model.annexLibraries(lname).find(({ pkg }) => lc(pkg.name) === lc(m[1]));
      return (lib?.annex.parsed?.specs || []).filter((s) => s.name).map((s) => ({ label: s.name, kind: s.kind === "const" ? CompletionItemKind.Constant : CompletionItemKind.Function, detail: `${s.kind} in ${lib.pkg.name}` }));
    }
    if (cls && (m = /(\w+)\.(\w*)$/.exec(before))) {
      const sub = model.allSubcomponents(cls).find((x) => lc(x.name) === lc(m[1]));
      if (sub?._classifier) return model.allFeatures(sub._classifier).map((f) => ({ label: f.name, kind: CompletionItemKind.Field, detail: [f.direction, f.featureKind, f.classifier?.name].filter(Boolean).join(" ") }));
      return [];
    }
    const items = keywords.map((k) => kw(k, `${entry.annex.name} keyword`));
    if (lname === "agree") {
      items.push(
        snippet("guarantee", "guarantee \"${1:description}\" : ${2:true};", "AGREE guarantee"),
        snippet("assume", "assume \"${1:description}\" : ${2:true};", "AGREE assumption"),
        snippet("lemma", "lemma \"${1:description}\" : ${2:true};", "AGREE lemma"),
        snippet("eq", "eq ${1:name} : ${2:int} = ${3:0};", "AGREE equation"),
      );
    }
    if (cls) {
      for (const f of model.allFeatures(cls)) items.push({ label: f.name, kind: CompletionItemKind.Field, detail: [f.direction, f.featureKind, f.classifier?.name].filter(Boolean).join(" ") });
      for (const s of model.allSubcomponents(cls)) items.push({ label: s.name, kind: CompletionItemKind.Variable, detail: `${s.category} ${s.classifier?.name || ""}` });
      for (const { annex } of model.annexSubclauses(cls, lname)) {
        for (const sp of annex.parsed?.specs || []) {
          for (const v of sp.vars || []) items.push({ label: v.name, kind: CompletionItemKind.Variable, detail: `eq : ${v.type.name}` });
          if (sp.kind === "const" || sp.kind === "property") items.push({ label: sp.name, kind: CompletionItemKind.Constant, detail: sp.kind });
        }
      }
    }
    for (const { pkg, annex } of model.annexLibraries(lname)) {
      for (const sp of annex.parsed?.specs || []) if (sp.name) items.push({ label: `${pkg.name}::${sp.name}`, kind: sp.kind === "const" ? CompletionItemKind.Constant : CompletionItemKind.Function, detail: `${sp.kind}` });
    }
    return items;
  }
}
