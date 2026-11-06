// Behavior Annex / BLESS semantic checks: name resolution and typing of
// variables, guards and actions against the component's features, plus
// state-machine structure (initial/complete/final states, reachability).

const lc = (s) => (s || "").toLowerCase();
const NUM = new Set(["int", "real"]);

export function behaviorSubclauses(model, c) {
  return [...model.annexSubclauses(c, "behavior_specification"), ...model.annexSubclauses(c, "bless")]
    .filter((x) => x.annex.parsed && (x.annex.parsed.kind === "behavior" || x.annex.parsed.kind === "bless"));
}

function typeOfClassifier(model, name, pkg) {
  const lname = lc(name);
  if (["integer", "int", "natural"].includes(lname)) return "int";
  if (["boolean", "bool"].includes(lname)) return "bool";
  if (["real", "float"].includes(lname)) return "real";
  if (lname === "string") return "string";
  const c = model.resolveClassifier(name, pkg);
  if (!c) return null;
  const rep = model.dataRepresentation(c);
  if (rep) return rep;
  if (/string/i.test(c.name)) return "string";
  return "data";
}

/** Check one subclause; `report(severity, message, loc)`. Returns the scope used (for analyses). */
export function checkBehavior(model, c, annex, report) {
  const ba = annex.parsed;
  const what = ba.kind === "bless" ? "BLESS" : "Behavior Annex";
  const scope = new Map();
  for (const f of model.allFeatures(c)) {
    let type = null;
    if (f._classifier) type = model.dataRepresentation(f._classifier) || "data";
    scope.set(lc(f.name), { kind: f.featureKind?.includes("access") ? "access" : "port", decl: f, type, direction: f.direction, featureKind: f.featureKind });
  }
  if (c.kind === "componentImpl") {
    for (const s of model.allSubcomponents(c)) {
      if (s.category === "data") scope.set(lc(s.name), { kind: "variable", type: s._classifier ? model.dataRepresentation(s._classifier) || "data" : "data", decl: s });
    }
  }
  for (const v of ba.variables) {
    const type = typeOfClassifier(model, v.type, c.pkg);
    if (!type) report("error", `${what}: unknown type '${v.type}' for variable '${v.name}'`, v.loc);
    if (scope.has(lc(v.name)) && scope.get(lc(v.name)).kind === "variable") report("error", `${what}: duplicate variable '${v.name}'`, v.loc);
    scope.set(lc(v.name), { kind: "variable", type: type || "data", decl: v });
  }

  // States
  const states = new Map();
  for (const s of ba.states) {
    if (states.has(lc(s.name))) report("error", `${what}: duplicate state '${s.name}'`, s.loc);
    states.set(lc(s.name), s);
  }
  const initial = ba.states.filter((s) => s.initial);
  if (ba.states.length && initial.length !== 1) report("error", `${what}: exactly one initial state is required (found ${initial.length})`, (initial[1] || ba.states[0]).loc);
  const isThread = /thread|device/.test(c.category);
  const dispatch = isThread ? lc(findDispatch(model, c)) : null;
  if (dispatch && dispatch !== "background" && initial[0] && !initial[0].complete && !ba.states.some((s) => s.complete)) {
    report("warning", `${what}: a ${dispatch} ${c.category} needs a complete state to wait for dispatch`, initial[0].loc);
  }

  // Expressions
  const typeOf = (e, locals) => {
    if (!e) return null;
    switch (e.kind) {
      case "lit":
        return e.unit ? "time" : e.type;
      case "ref": {
        const head = lc(e.path[0]);
        const sym = locals.get(head) || scope.get(head);
        if (!sym) {
          report("error", `${what}: unknown name '${e.path.join(".")}'`, e.loc);
          return null;
        }
        if (e.attribute) {
          if (sym.kind !== "port") report("error", `${what}: '${e.path[0]}'${e.attribute} needs a port`, e.loc);
          if (e.attribute === "count") return "int";
          if (e.attribute === "fresh" || e.attribute === "updated") return "bool";
          return null;
        }
        if (sym.kind === "port" && /event port/.test(sym.featureKind || "") && !/data/.test(sym.featureKind)) {
          report("error", `${what}: event port '${e.path[0]}' has no value (use '${e.path[0]}'count)`, e.loc);
          return null;
        }
        return e.path.length > 1 ? null : sym.type === "data" ? null : sym.type;
      }
      case "un": {
        const t = typeOf(e.e, locals);
        if (e.op === "not") {
          if (t && t !== "bool") report("error", `${what}: 'not' needs a boolean operand`, e.loc);
          return "bool";
        }
        if (t && !NUM.has(t)) report("error", `${what}: '${e.op}' needs a numeric operand`, e.loc);
        return t;
      }
      case "bin": {
        const a = typeOf(e.l, locals), b = typeOf(e.r, locals);
        if (["and", "or", "xor"].includes(e.op)) {
          for (const t of [a, b]) if (t && t !== "bool") report("error", `${what}: '${e.op}' needs boolean operands`, e.l.loc || e.r.loc);
          return "bool";
        }
        if (["=", "!="].includes(e.op)) {
          if (a && b && a !== b && !(NUM.has(a) && NUM.has(b))) report("error", `${what}: cannot compare ${a} with ${b}`, e.l.loc);
          return "bool";
        }
        if (["<", "<=", ">", ">="].includes(e.op)) {
          for (const t of [a, b]) if (t && !NUM.has(t) && t !== "time") report("error", `${what}: '${e.op}' needs numeric operands`, e.l.loc);
          return "bool";
        }
        for (const t of [a, b]) if (t && !NUM.has(t) && t !== "time") report("error", `${what}: '${e.op}' needs numeric operands`, e.l.loc);
        if (["mod", "rem"].includes(e.op)) return "int";
        return a === "real" || b === "real" ? "real" : a || b;
      }
      case "call":
        for (const arg of e.args) typeOf(arg, locals);
        return null;
      default:
        return null;
    }
  };

  const checkActions = (acts, locals) => {
    for (const a of acts || []) {
      switch (a.kind) {
        case "assign": {
          const sym = locals.get(lc(a.target.path[0])) || scope.get(lc(a.target.path[0]));
          const vt = typeOf(a.value, locals);
          if (!sym) report("error", `${what}: unknown assignment target '${a.target.path.join(".")}'`, a.loc);
          else if (sym.kind === "port" && !/out/.test(sym.direction || "")) report("error", `${what}: cannot assign to input port '${a.target.path[0]}'`, a.loc);
          else if (sym.kind === "access") report("error", `${what}: cannot assign to access feature '${a.target.path[0]}'`, a.loc);
          else if (sym.type && vt && sym.type !== "data" && vt !== sym.type && !(sym.type === "real" && vt === "int")) {
            report("error", `${what}: cannot assign ${vt} to '${a.target.path[0]}' (${sym.type})`, a.loc);
          }
          break;
        }
        case "send": {
          const sym = scope.get(lc(a.target.path[0]));
          for (const arg of a.args) typeOf(arg, locals);
          if (!sym) report("error", `${what}: unknown port or subprogram '${a.target.path.join(".")}'`, a.loc);
          else if (sym.kind === "port" && !/out/.test(sym.direction || "")) report("error", `${what}: '${a.target.path[0]}!' needs an output port`, a.loc);
          break;
        }
        case "receive": {
          const sym = scope.get(lc(a.target.path[0]));
          if (!sym) report("error", `${what}: unknown port '${a.target.path.join(".")}'`, a.loc);
          else if (sym.kind !== "port" || !/in/.test(sym.direction || "")) report("error", `${what}: '${a.target.path[0]}?' needs an input port`, a.loc);
          if (a.into && !(locals.get(lc(a.into.path[0])) || scope.get(lc(a.into.path[0])))) report("error", `${what}: unknown variable '${a.into.path[0]}'`, a.into.loc);
          break;
        }
        case "if":
          for (const b of a.branches) {
            const t = typeOf(b.cond, locals);
            if (t && t !== "bool") report("error", `${what}: if condition must be boolean`, a.loc);
            checkActions(b.body, locals);
          }
          checkActions(a.otherwise, locals);
          break;
        case "while": {
          const t = typeOf(a.cond, locals);
          if (t && t !== "bool") report("error", `${what}: loop condition must be boolean`, a.loc);
          checkActions(a.body, locals);
          break;
        }
        case "for": {
          typeOf(a.from, locals);
          typeOf(a.to, locals);
          const inner = new Map(locals).set(lc(a.variable), { kind: "variable", type: typeOfClassifier(model, a.type, c.pkg) || "int" });
          checkActions(a.body, inner);
          break;
        }
        case "block":
          checkActions(a.body, locals);
          break;
        case "computation":
          typeOf(a.min, locals);
          break;
        default:
      }
    }
  };

  for (const t of ba.transitions) {
    for (const s of t.sources) if (!states.has(lc(s))) report("error", `${what}: transition ${t.name || ""} from unknown state '${s}'`, t.loc);
    if (!states.has(lc(t.dst))) report("error", `${what}: transition ${t.name || ""} to unknown state '${t.dst}'`, t.loc);
    if (t.guard.kind === "dispatch") {
      for (const s of t.sources) {
        const st = states.get(lc(s));
        if (st && !st.complete) report("error", `${what}: dispatch condition on transition from '${s}', which is not a complete state`, t.loc);
      }
      for (const trig of t.guard.triggers) {
        const sym = scope.get(lc(trig.split(".")[0]));
        if (!sym || sym.kind !== "port" || !/event/.test(sym.featureKind || "") && sym.kind !== "access") {
          report("error", `${what}: dispatch trigger '${trig}' must be an event or event data port`, t.loc);
        }
      }
    } else if (t.guard.kind === "condition") {
      const g = typeOf(t.guard.expr, new Map());
      if (g && g !== "bool") report("error", `${what}: transition guard must be boolean, found ${g}`, t.loc);
    }
    checkActions(t.actions, new Map());
  }
  return { states, scope };
}

function findDispatch(model, c) {
  const pa = model.classifierProperties(c).filter((p) => /(^|::)dispatch_protocol$/i.test(p.name) && !p.appliesTo.length).at(-1);
  return pa?.value?.type === "name" ? pa.value.name : null;
}

export function validateBehavior(model, report) {
  for (const pkg of model.packages.values()) {
    for (const c of pkg.classifiers) {
      for (const annex of c.annexes) {
        if ((annex.lname === "behavior_specification" || annex.lname === "bless") && annex.parsed) checkBehavior(model, c, annex, report);
      }
    }
  }
}

// ---- state machine analysis -----------------------------------------------------------------

export function stateMachine(ba) {
  const initial = ba.states.find((s) => s.initial);
  const succ = new Map(ba.states.map((s) => [lc(s.name), new Set()]));
  for (const t of ba.transitions) for (const s of t.sources) succ.get(lc(s))?.add(lc(t.dst));
  const reachable = new Set();
  if (initial) {
    const queue = [lc(initial.name)];
    while (queue.length) {
      const s = queue.shift();
      if (reachable.has(s)) continue;
      reachable.add(s);
      for (const n of succ.get(s) || []) queue.push(n);
    }
  }
  const unreachable = ba.states.filter((s) => !reachable.has(lc(s.name)));
  const deadlocks = ba.states.filter((s) => !s.final && reachable.has(lc(s.name)) && !(succ.get(lc(s.name))?.size));
  return { initial, reachable, unreachable, deadlocks };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export function guardText(g) {
  if (!g) return "";
  if (g.kind === "dispatch") return g.timeout ? "on dispatch timeout" : `on dispatch${g.triggers.length ? " " + g.triggers.join(" or ") : ""}`;
  if (g.kind === "otherwise") return "otherwise";
  if (g.kind === "timeout") return "timeout";
  if (g.kind === "condition") return exprText(g.expr);
  return "";
}

export function exprText(e) {
  if (!e) return "";
  switch (e.kind) {
    case "lit": return `${e.type === "string" ? JSON.stringify(e.value) : e.value}${e.unit ? " " + e.unit : ""}`;
    case "ref": return `${e.path.join(".")}${e.attribute ? "'" + e.attribute : ""}`;
    case "un": return `${e.op}${e.op === "-" ? "" : " "}${exprText(e.e)}`;
    case "bin": return `${exprText(e.l)} ${e.op} ${exprText(e.r)}`;
    case "call": return `${e.name}(${e.args.map(exprText).join(", ")})`;
    default: return "?";
  }
}

/** Circular-layout SVG state diagram. */
export function stateDiagramSvg(ba, analysis) {
  const n = ba.states.length;
  const R = Math.max(90, n * 34);
  const cx = R + 90, cy = R + 60;
  const pos = new Map(ba.states.map((s, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    return [lc(s.name), { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) }];
  }));
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" class="aadl-diagram" viewBox="0 0 ${2 * cx} ${2 * cy - 20}" width="${2 * cx}" height="${2 * cy - 20}">`,
    `<defs><marker id="sm-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" class="d-arrow"/></marker></defs>`];
  const pairs = new Map();
  for (const t of ba.transitions) {
    for (const s of t.sources) {
      const a = pos.get(lc(s)), b = pos.get(lc(t.dst));
      if (!a || !b) continue;
      const k = `${lc(s)}>${lc(t.dst)}`;
      const nth = pairs.get(k) || 0;
      pairs.set(k, nth + 1);
      const label = `${t.name ? t.name + ": " : ""}${guardText(t.guard)}`;
      if (a === b) {
        parts.push(`<path class="d-conn" d="M${a.x - 12},${a.y - 26} C${a.x - 50},${a.y - 90} ${a.x + 50},${a.y - 90} ${a.x + 12},${a.y - 26}" marker-end="url(#sm-arrow)"/><text class="d-port-label" x="${a.x}" y="${a.y - 78 - nth * 12}" text-anchor="middle">${esc(label)}</text>`);
        continue;
      }
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const bend = 24 + nth * 16;
      const sx = a.x + ux * 30, sy = a.y + uy * 30, ex = b.x - ux * 32, ey = b.y - uy * 32;
      const mx = (sx + ex) / 2 - uy * bend, my = (sy + ey) / 2 + ux * bend;
      parts.push(`<path class="d-conn" d="M${sx},${sy} Q${mx},${my} ${ex},${ey}" marker-end="url(#sm-arrow)"><title>${esc(label)}</title></path>`);
      parts.push(`<text class="d-port-label" x="${mx}" y="${my}" text-anchor="middle">${esc(label.length > 34 ? label.slice(0, 33) + "…" : label)}</text>`);
    }
  }
  for (const s of ba.states) {
    const p = pos.get(lc(s.name));
    const dead = analysis.unreachable.includes(s) || analysis.deadlocks.includes(s);
    parts.push(`<g class="d-comp"><circle class="d-box" cx="${p.x}" cy="${p.y}" r="28" ${dead ? 'stroke-dasharray="4 3"' : ""}/>`);
    if (s.final) parts.push(`<circle class="d-box" cx="${p.x}" cy="${p.y}" r="23"/>`);
    if (s.complete) parts.push(`<circle cx="${p.x}" cy="${p.y + 18}" r="3" class="d-arrow"/>`);
    parts.push(`<text class="d-name" x="${p.x}" y="${p.y + 4}" text-anchor="middle">${esc(s.name)}</text></g>`);
    if (s.initial) parts.push(`<path class="d-conn" d="M${p.x - 70},${p.y} L${p.x - 30},${p.y}" marker-end="url(#sm-arrow)"/><circle cx="${p.x - 72}" cy="${p.y}" r="5" class="d-arrow"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
