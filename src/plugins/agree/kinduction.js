// Bounded model checking + k-induction over a translated Program, using any
// SMT-LIB2 solver exposed as `{ eval(script: string): Promise<string> }`
// (Z3 compiled to WebAssembly in the browser, the z3-solver package in tests).
//
// The program is lowered to a transition system: every `pre(e)` gets a state
// variable s with s' = e, and `a -> b` reads the `$init` flag.

const SMT_TYPE = { bool: "Bool", int: "Int", real: "Real" };

function q(name, k) {
  return `|${name}@${k}|`;
}

function smtNumber(type, v) {
  let s = String(v);
  if (type === "int") return s.startsWith("-") ? `(- ${s.slice(1)})` : s;
  let neg = false;
  if (s.startsWith("-")) {
    neg = true;
    s = s.slice(1);
  }
  let out;
  const m = s.match(/^([0-9.]+)[eE]([-+]?[0-9]+)$/);
  if (m) {
    const mant = m[1].includes(".") ? m[1] : `${m[1]}.0`;
    const exp = Number(m[2]);
    const pow = `1${"0".repeat(Math.abs(exp))}.0`;
    out = exp >= 0 ? `(* ${mant} ${pow})` : `(/ ${mant} ${pow})`;
  } else {
    out = s.includes(".") ? s : `${s}.0`;
  }
  return neg ? `(- ${out})` : out;
}

const SMT_OPS = {
  and: "and", or: "or", "=>": "=>", "<=>": "=", "=": "=", "<": "<", "<=": "<=", ">": ">", ">=": ">=",
  "+": "+", "-": "-", "*": "*", "/": "/", div: "div", mod: "mod",
};

export class TransitionSystem {
  constructor(program) {
    this.program = program;
    this.stateVars = []; // { name, type, next }
    this.preIds = new Map();
    // Register pre() terms everywhere up front so declarations are known.
    for (const v of program.locals) this.collect(v.expr);
    for (const a of program.asserts) this.collect(a.expr);
    for (const p of program.props) this.collect(p.expr);
  }

  collect(e) {
    if (!e || !e.args) return;
    for (const a of e.args) this.collect(a);
    if (e.op === "pre" && !this.preIds.has(e)) {
      const name = `$pre${this.stateVars.length}`;
      this.preIds.set(e, name);
      this.stateVars.push({ name, type: e.type, next: e.args[0] });
    }
  }

  term(e, k) {
    switch (e.op) {
      case "var":
        return q(e.name, k);
      case "lit":
        return e.type === "bool" ? (e.v ? "true" : "false") : smtNumber(e.type, e.v);
      case "not":
        return `(not ${this.term(e.args[0], k)})`;
      case "neg":
        return `(- ${this.term(e.args[0], k)})`;
      case "pre":
        return q(this.preIds.get(e), k);
      case "arrow":
        return `(ite ${q("$init", k)} ${this.term(e.args[0], k)} ${this.term(e.args[1], k)})`;
      case "ite":
        return `(ite ${this.term(e.args[0], k)} ${this.term(e.args[1], k)} ${this.term(e.args[2], k)})`;
      case "toReal":
        return `(to_real ${this.term(e.args[0], k)})`;
      case "floor":
        return `(to_int ${this.term(e.args[0], k)})`;
      case "<>":
        return `(not (= ${this.term(e.args[0], k)} ${this.term(e.args[1], k)}))`;
      default: {
        const op = SMT_OPS[e.op];
        if (!op) throw new Error(`No SMT encoding for '${e.op}'`);
        return `(${op} ${this.term(e.args[0], k)} ${this.term(e.args[1], k)})`;
      }
    }
  }

  declare(k) {
    const out = [`(declare-const ${q("$init", k)} Bool)`];
    for (const v of this.program.vars.values()) out.push(`(declare-const ${q(v.name, k)} ${SMT_TYPE[v.type]})`);
    for (const s of this.stateVars) out.push(`(declare-const ${q(s.name, k)} ${SMT_TYPE[s.type]})`);
    return out;
  }

  /** Definitions and assertions that hold at step k. */
  step(k) {
    const out = [];
    for (const v of this.program.locals) out.push(`(assert (= ${q(v.name, k)} ${this.term(v.expr, k)}))`);
    for (const a of this.program.asserts) out.push(`(assert ${this.term(a.expr, k)})`);
    return out;
  }

  /** Transition from step k to k+1. */
  trans(k) {
    const out = [`(assert (not ${q("$init", k + 1)}))`];
    for (const s of this.stateVars) out.push(`(assert (= ${q(s.name, k + 1)} ${this.term(s.next, k)}))`);
    return out;
  }

  /** Unroll steps 0..n. */
  unroll(n, { initial }) {
    const out = [];
    for (let k = 0; k <= n; k++) out.push(...this.declare(k));
    if (initial) out.push(`(assert ${q("$init", 0)})`);
    for (let k = 0; k <= n; k++) out.push(...this.step(k));
    for (let k = 0; k < n; k++) out.push(...this.trans(k));
    return out;
  }
}

// ---- S-expression results ---------------------------------------------------

export function parseSexpr(text) {
  let i = 0;
  const parse = () => {
    while (/\s/.test(text[i])) i++;
    if (text[i] === "(") {
      i++;
      const list = [];
      for (;;) {
        while (/\s/.test(text[i])) i++;
        if (text[i] === ")") {
          i++;
          return list;
        }
        if (i >= text.length) throw new Error("Unbalanced S-expression");
        list.push(parse());
      }
    }
    if (text[i] === "|") {
      const end = text.indexOf("|", i + 1);
      const s = text.slice(i + 1, end);
      i = end + 1;
      return { sym: s };
    }
    let j = i;
    while (j < text.length && !/[\s()]/.test(text[j])) j++;
    const atom = text.slice(i, j);
    i = j;
    return atom;
  };
  return parse();
}

/** Evaluate a model value S-expression into { value: number|boolean, text }. */
export function evalValue(v) {
  if (typeof v === "string") {
    if (v === "true" || v === "false") return { value: v === "true", text: v };
    const n = Number(v);
    return { value: n, text: v.endsWith(".0") ? v.slice(0, -2) : v };
  }
  if (Array.isArray(v)) {
    if (v[0] === "-" && v.length === 2) {
      const x = evalValue(v[1]);
      return { value: -x.value, text: `-${x.text}` };
    }
    if (v[0] === "/" && v.length === 3) {
      const a = evalValue(v[1]);
      const b = evalValue(v[2]);
      const value = a.value / b.value;
      const dec = Number(value.toPrecision(8));
      return { value, text: Number.isInteger(value) ? String(value) : `${dec}` + (Math.abs(dec - value) > 1e-12 ? ` (${a.text}/${b.text})` : "") };
    }
  }
  return { value: NaN, text: JSON.stringify(v) };
}

// ---- k-induction --------------------------------------------------------------

/**
 * Check all properties of a program.
 * @param {object} program Program from translate.js
 * @param {{ eval(s: string): Promise<string> }} solver
 * @param {{ maxK?: number, consistencyDepth?: number, onProgress?: (msg: string) => void }} [opts]
 */
export async function checkProgram(program, solver, opts = {}) {
  const maxK = opts.maxK ?? 8;
  const progress = opts.onProgress || (() => {});
  const ts = new TransitionSystem(program);
  const props = program.props.map((p) => ({ ...p, status: "unknown", k: null, cex: null }));
  const run = async (lines) => {
    const out = await solver.eval(["(push 1)", ...lines, "(pop 1)"].join("\n"));
    return out;
  };
  await solver.eval("(set-option :produce-models true)");

  // Consistency: some execution must satisfy every assumption and assertion.
  const depth = opts.consistencyDepth ?? 3;
  progress(`Checking contract consistency (${depth + 1} steps)`);
  const consistent = (await run([...ts.unroll(depth, { initial: true }), "(check-sat)"])).trim();
  const consistency = { status: consistent.startsWith("sat") ? "consistent" : consistent.startsWith("unsat") ? "inconsistent" : "unknown", depth };

  const valid = [];
  const propAt = (p, k) => ts.term(p.expr, k);
  const assumeValid = (n) => {
    const out = [];
    for (const p of valid) for (let k = 0; k <= n; k++) out.push(`(assert ${propAt(p, k)})`);
    return out;
  };

  for (let k = 0; k <= maxK; k++) {
    const open = props.filter((p) => p.status === "unknown");
    if (!open.length) break;
    progress(`k = ${k}: base case for ${open.length} propert${open.length === 1 ? "y" : "ies"}`);
    // Base case: no counterexample of length k+1.
    for (const p of open) {
      const lines = [...ts.unroll(k, { initial: true }), ...assumeValid(k), `(assert (not ${propAt(p, k)}))`, "(check-sat)"];
      const res = (await run(lines)).trim();
      if (res.startsWith("sat")) {
        p.status = "invalid";
        p.k = k;
        p.cex = await counterexample(ts, solver, lines.slice(0, -1), k, p);
      } else if (!res.startsWith("unsat")) {
        p.status = "unknown";
        p.note = res;
      }
    }
    const stillOpen = props.filter((p) => p.status === "unknown");
    if (!stillOpen.length) break;
    progress(`k = ${k}: induction step for ${stillOpen.length} propert${stillOpen.length === 1 ? "y" : "ies"}`);
    // Inductive step, one property at a time.
    for (const p of stillOpen) {
      const lines = [...ts.unroll(k + 1, { initial: false }), ...assumeValid(k + 1)];
      for (let i = 0; i <= k; i++) lines.push(`(assert ${propAt(p, i)})`);
      lines.push(`(assert (not ${propAt(p, k + 1)}))`, "(check-sat)");
      const res = (await run(lines)).trim();
      if (res.startsWith("unsat")) {
        p.status = "valid";
        p.k = k;
        valid.push(p);
      }
    }
    // Joint inductive step for what remains: the conjunction may be inductive even if no single property is.
    const joint = props.filter((p) => p.status === "unknown");
    if (joint.length > 1) {
      const lines = [...ts.unroll(k + 1, { initial: false }), ...assumeValid(k + 1)];
      for (const p of joint) for (let i = 0; i <= k; i++) lines.push(`(assert ${propAt(p, i)})`);
      lines.push(`(assert (not (and ${joint.map((p) => propAt(p, k + 1)).join(" ")})))`, "(check-sat)");
      const res = (await run(lines)).trim();
      if (res.startsWith("unsat")) {
        for (const p of joint) {
          p.status = "valid";
          p.k = k;
          p.joint = true;
          valid.push(p);
        }
      }
    }
  }
  return { props, consistency, maxK };
}

async function counterexample(ts, solver, lines, k, prop) {
  const program = ts.program;
  const vars = [...program.vars.values()].filter((v) => v.visible);
  const terms = [];
  for (let i = 0; i <= k; i++) for (const v of vars) terms.push(q(v.name, i));
  const propTerms = [];
  for (let i = 0; i <= k; i++) propTerms.push(ts.term(prop.expr, i));
  const out = await solver.eval(["(push 1)", ...lines, "(check-sat)", `(get-value (${terms.join(" ")}))`, `(get-value (${propTerms.join(" ")}))`, "(pop 1)"].join("\n"));
  // Output: "sat\n((|x@0| 1) ...)\n((expr val) ...)"
  const firstParen = out.indexOf("(");
  const rest = out.slice(firstParen);
  const values = new Map();
  let propValues = [];
  try {
    const [assigns, propAssigns] = splitTopLevel(rest).map(parseSexpr);
    for (const [sym, val] of assigns) values.set(sym.sym || sym, evalValue(val));
    propValues = propAssigns.map(([, val]) => evalValue(val).text);
  } catch (e) {
    return { steps: k + 1, error: `Could not read counterexample: ${e.message}`, raw: out };
  }
  return {
    steps: k + 1,
    property: propValues,
    rows: vars.map((v) => ({
      name: v.label,
      stream: v.name,
      scope: v.scope,
      role: v.role,
      values: Array.from({ length: k + 1 }, (_, i) => values.get(`${v.name}@${i}`)?.text ?? "?"),
    })),
  };
}

function splitTopLevel(s) {
  const parts = [];
  let depth = 0, start = -1, inBar = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "|") inBar = !inBar;
    if (inBar) continue;
    if (c === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) parts.push(s.slice(start, i + 1));
    }
  }
  return parts;
}
