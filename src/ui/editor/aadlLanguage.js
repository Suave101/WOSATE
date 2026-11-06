// CodeMirror 6 stream language for AADL, with `{** ... **}` annex bodies
// highlighted using the keywords that annex plug-ins contribute.

import { StreamLanguage, HighlightStyle, syntaxHighlighting, indentService } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Tag, tags as t } from "@lezer/highlight";

const AADL_KEYWORDS = [
  "package", "public", "private", "with", "end", "is", "none", "renames", "system", "process", "thread", "group",
  "processor", "virtual", "memory", "bus", "device", "data", "subprogram", "abstract", "implementation", "extends",
  "features", "flows", "properties", "annex", "modes", "mode", "subcomponents", "connections", "in", "out", "port",
  "event", "access", "requires", "provides", "feature", "parameter", "flow", "source", "sink", "path", "to",
  "applies", "reference", "classifier", "constant", "property", "set", "type", "true", "false", "delta", "calls",
  "prototypes", "refined", "inverse", "of", "binding", "compute", "internal", "initial", "transitions",
];

const annexTag = Tag.define();

export function aadlLanguage(annexKeywords = []) {
  const aadlWords = new Set(AADL_KEYWORDS);
  const annexWords = new Set(annexKeywords.map((w) => w.toLowerCase()));
  return StreamLanguage.define({
    name: "aadl",
    startState: () => ({ annex: false }),
    token(stream, state) {
      if (state.annex) {
        if (stream.match("**}")) {
          state.annex = false;
          return "meta";
        }
        if (stream.eatSpace()) return "annex";
        if (stream.match("--")) {
          stream.skipToEnd();
          return "comment annex";
        }
        if (stream.match(/^"[^"]*"?/)) return "string annex";
        if (stream.match(/^[0-9][0-9_]*(\.[0-9_]+)?/)) return "number annex";
        if (stream.match(/^[A-Za-z_]\w*/)) return annexWords.has(stream.current().toLowerCase()) ? "keyword annex" : "annex";
        stream.next();
        return "annex";
      }
      if (stream.eatSpace()) return null;
      if (stream.match("--")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match("{**")) {
        state.annex = true;
        return "meta";
      }
      if (stream.match(/^"[^"]*"?/)) return "string";
      if (stream.match(/^[0-9][0-9_]*(\.[0-9_]+)?([eE][-+]?[0-9]+)?/)) return "number";
      if (stream.match(/^[A-Za-z_]\w*(?=\s*::)/)) return "typeName";
      if (stream.match(/^::[A-Za-z_]\w*(\.[A-Za-z_]\w*)?/)) return "typeName";
      if (stream.match(/^[A-Za-z_]\w*/)) return aadlWords.has(stream.current().toLowerCase()) ? "keyword" : "variableName";
      stream.next();
      return null;
    },
    tokenTable: { annex: annexTag },
    languageData: { commentTokens: { line: "--" } },
  });
}

const SECTION_RE = /^(features|flows|modes|properties|prototypes|requires|subcomponents|connections|calls|internal)\b/i;
const HEADER_RE = /^((thread|virtual|subprogram)\s+(group|processor|bus)|system|process|thread|processor|memory|bus|device|data|subprogram|abstract)\s+(implementation\s+)?[A-Za-z_]/i;

/**
 * AADL indentation: classifiers sit one level inside `public`/`private`, sections one level
 * inside their classifier, members one level inside their section; `end` and section keywords
 * re-indent as they are typed. Annex bodies keep the previous line's indentation.
 */
export const aadlIndentation = [
  indentService.of((cx, pos) => {
    const doc = cx.state.doc;
    const line = doc.lineAt(pos);
    const unit = cx.unit;
    const current = cx.textAfterPos(pos).trim();
    // Find the previous non-blank line.
    let prev = null;
    for (let n = line.number - 1; n >= 1; n--) {
      const t = doc.line(n).text;
      if (t.trim()) {
        prev = t;
        break;
      }
    }
    if (prev === null) return 0;
    const indentOf = (t) => /^\s*/.exec(t)[0].replace(/\t/g, "  ").length;
    const before = doc.sliceString(0, line.from);
    const inAnnex = before.lastIndexOf("{**") > before.lastIndexOf("**}");
    const p = prev.trim();
    if (inAnnex) return /\{\*\*\s*$/.test(p) ? indentOf(prev) + unit : /^\*\*\}/.test(current) ? Math.max(0, indentOf(prev) - unit) : indentOf(prev);
    // Header of the enclosing classifier (for `end` and section keywords).
    const headerIndent = () => {
      for (let n = line.number - 1; n >= 1; n--) {
        const t = doc.line(n).text.trim();
        if (/^end\s+[\w.]+\s*;/i.test(t)) return null;
        if (HEADER_RE.test(t)) return indentOf(doc.line(n).text);
        if (/^(package|public|private)\b/i.test(t)) return null;
      }
      return null;
    };
    if (/^end\b/i.test(current)) {
      const h = headerIndent();
      return h === null ? 0 : h;
    }
    if (SECTION_RE.test(current) || /^annex\b/i.test(current)) {
      const h = headerIndent();
      if (h !== null) return h + unit;
    }
    if (/^(public|private)\b/i.test(current)) return 0;
    if (/^(public|private)$/i.test(p)) return unit;
    if (/^package\b/i.test(p)) return 0;
    if (HEADER_RE.test(p) && !/;\s*$/.test(p)) return indentOf(prev) + unit;
    if (SECTION_RE.test(p) && !/\bnone\s*;/i.test(p)) return indentOf(prev) + unit;
    if (/^end\s+[\w.]+\s*;/i.test(p)) return indentOf(prev);
    if (/\*\*\}\s*;\s*$/.test(p)) return indentOf(prev);
    if (/^properties$/i.test(p)) return indentOf(prev) + unit;
    return indentOf(prev);
  }),
  EditorState.languageData.of(() => [{ indentOnInput: /^\s*(end|features|flows|modes|properties|subcomponents|connections|calls|annex|public|private|\*\*\})$/i }]),
];

export const aadlHighlighting =syntaxHighlighting(HighlightStyle.define([
  { tag: t.keyword, color: "var(--tok-kw)" },
  { tag: t.typeName, color: "var(--tok-type)" },
  { tag: t.variableName, color: "var(--tok-var)" },
  { tag: t.string, color: "var(--tok-str)" },
  { tag: t.number, color: "var(--tok-num)" },
  { tag: t.comment, color: "var(--tok-comment)" },
  { tag: t.meta, color: "var(--tok-meta)" },
  { tag: annexTag, backgroundColor: "var(--tok-annex-bg)" },
]));
