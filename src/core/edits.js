// AST-driven source edits: the graphical canvas changes the model by editing
// AADL text at positions taken from the parsed AST, so text stays the single
// source of truth and both views stay in sync.

import { tokenize, AADL_OPERATORS } from "./lexer.js";

const lc = (s) => (s || "").toLowerCase();
const SECTION_ORDER = ["prototypes", "subcomponents", "internal", "calls", "connections", "flows", "modes", "properties", "annex"];

const lineStart = (text, pos) => text.lastIndexOf("\n", pos - 1) + 1;
const indentAt = (text, pos) => /^[ \t]*/.exec(text.slice(lineStart(text, pos)))[0];

/** Range of the member statement starting at `pos` (through its ';', plus the line if it is alone on it). */
export function statementRange(text, pos) {
  let from = pos;
  const ls = lineStart(text, pos);
  if (!text.slice(ls, pos).trim()) from = ls;
  let i = pos, depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    if (ch === "}" || ch === ")" || ch === "]") depth--;
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === ";" && depth <= 0) break;
    i++;
  }
  let to = Math.min(text.length, i + 1);
  const rest = /^[ \t]*(--[^\n]*)?\r?\n/.exec(text.slice(to));
  if (rest && from === ls) to += rest[0].length;
  return { from, to };
}

export function applyEdits(text, edits) {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/** Section keyword tokens (`subcomponents`, `connections`, …) that start a line inside a classifier. */
function sections(text, cls) {
  const body = text.slice(cls.startPos, cls.endPos);
  const tokens = tokenize(body, { operators: AADL_OPERATORS, annexBlocks: true, offset: cls.startPos });
  const out = [];
  for (const t of tokens) {
    if (t.type !== "id" || !SECTION_ORDER.includes(t.lower)) continue;
    if (text.slice(lineStart(text, t.pos), t.pos).trim()) continue;
    out.push({ name: t.lower, pos: t.pos, end: t.end });
  }
  // `end Name;` of the classifier
  const endTok = [...tokens].reverse().find((t) => t.type === "id" && t.lower === "end");
  return { list: out, endPos: endTok ? endTok.pos : cls.endPos };
}

/** Insert `line` (without indentation) at the end of `section`, creating the section if needed. */
export function insertIntoSection(text, cls, section, line) {
  const { list, endPos } = sections(text, cls);
  const own = list.filter((s) => s.name === section);
  // Sections sit one level inside the classifier (whose `end` line gives its indentation).
  const headerIndent = list.length ? indentAt(text, list[0].pos) : indentAt(text, endPos) + "  ";
  if (own.length) {
    const sec = own.at(-1);
    const next = list.find((s) => s.pos > sec.pos);
    let at = next ? lineStart(text, next.pos) : lineStart(text, endPos);
    const between = text.slice(sec.end, at);
    // `features none;` style: replace `none;`
    const none = /^\s*none\s*;[ \t]*\r?\n?/.exec(between);
    const memberIndent = indentAt(text, sec.pos) + "  ";
    if (none) return applyEdits(text, [{ from: sec.end, to: sec.end + none[0].length, insert: `\n${memberIndent}${line}\n` }]);
    if (!text.slice(0, at).endsWith("\n")) at = text.indexOf("\n", at) + 1;
    return applyEdits(text, [{ from: at, to: at, insert: `${memberIndent}${line}\n` }]);
  }
  // New section: before the first section that should follow it, or before `end`.
  const rank = SECTION_ORDER.indexOf(section);
  const after = list.find((s) => SECTION_ORDER.indexOf(s.name) > rank);
  const at = lineStart(text, after ? after.pos : endPos);
  const ind = after ? indentAt(text, after.pos) : headerIndent;
  return applyEdits(text, [{ from: at, to: at, insert: `${ind}${section}\n${ind}  ${line}\n` }]);
}

/** Make sure `pkg` lists `name` in its with clause. */
export function ensureWith(text, pkg, name) {
  if (lc(pkg.name) === lc(name) || pkg.withs.some((w) => lc(w.name) === lc(name))) return text;
  if (pkg.withs.length) {
    const last = pkg.withs.at(-1);
    const semi = text.indexOf(";", last.loc.pos);
    return applyEdits(text, [{ from: semi, to: semi, insert: `, ${name}` }]);
  }
  const m = /\bpublic\b[^\n]*\n/i.exec(text.slice(pkg.loc.pos));
  const at = m ? pkg.loc.pos + m.index + m[0].length : text.indexOf("\n", pkg.loc.pos) + 1;
  return applyEdits(text, [{ from: at, to: at, insert: `  with ${name};\n` }]);
}

export function uniqueName(existing, base) {
  const taken = new Set(existing.map(lc));
  if (!taken.has(lc(base))) return base;
  for (let n = 1; ; n++) if (!taken.has(lc(`${base}${n}`))) return `${base}${n}`;
}

/** Reference to classifier `c` as written from package `pkg` (qualified across packages). */
export function classifierRef(pkg, c) {
  return lc(c.pkg) === lc(pkg.name) ? c.name : `${c.pkg}::${c.name}`;
}

export function addSubcomponent(text, pkg, impl, { name, classifier }) {
  let out = insertIntoSection(text, impl, "subcomponents", `${name}: ${classifier.category} ${classifierRef(pkg, classifier)};`);
  if (lc(classifier.pkg) !== lc(pkg.name)) out = ensureWith(out, pkg, classifier.pkg);
  return out;
}

/** Connection kind for two features, as AADL spells it. */
export function connectionKind(a, b) {
  const k = (f) => f?.featureKind || "";
  if (/port/.test(k(a)) && /port/.test(k(b))) return "port";
  if (/access/.test(k(a)) || /access/.test(k(b))) {
    const m = /(\w+(?: \w+)?) access/.exec(k(a)) || /(\w+(?: \w+)?) access/.exec(k(b));
    return `${m[1]} access`;
  }
  if (/feature group/.test(k(a))) return "feature group";
  if (/parameter/.test(k(a)) || /parameter/.test(k(b))) return "parameter";
  return "feature";
}

export function addConnection(text, impl, { name, kind, src, dst, bidirectional = false }) {
  const end = (e) => (e.context ? `${e.context}.${e.feature}` : e.feature);
  return insertIntoSection(text, impl, "connections", `${name}: ${kind} ${end(src)} ${bidirectional ? "<->" : "->"} ${end(dst)};`);
}

export function removeMembers(text, members) {
  return applyEdits(text, members.map((m) => {
    const r = statementRange(text, m.loc.pos);
    return { from: r.from, to: r.to, insert: "" };
  }));
}

/** Remove a subcomponent and every connection of the implementation that uses it. */
export function removeSubcomponent(text, impl, name) {
  const sub = impl.subcomponents.find((s) => lc(s.name) === lc(name));
  if (!sub) return text;
  const conns = impl.connections.filter((c) => lc(c.src.context) === lc(name) || lc(c.dst.context) === lc(name));
  return removeMembers(text, [sub, ...conns]);
}

/** Rename an identifier occurrence set computed by the language service (`edits` from rename). */
export function renameInText(text, ranges, newName) {
  return applyEdits(text, ranges.map((r) => ({ from: r.from, to: r.to, insert: newName })));
}
