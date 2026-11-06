// AGREE plug-in: annex parsing, compositional assume-guarantee verification
// with k-induction on Z3, and Lustre export.

import { parseAgree, AGREE_KEYWORDS } from "./parser.js";
import { translateImplementation, verificationTargets } from "./translate.js";
import { checkProgram } from "./kinduction.js";
import { toLustre } from "./lustre.js";
import { AGREE_EXAMPLES } from "./examples.js";

const STATUS = {
  valid: { status: "ok", label: "Valid" },
  invalid: { status: "error", label: "Invalid" },
  unknown: { status: "warning", label: "Unknown" },
};

function translateTargets(ctx, allLayers) {
  const targets = verificationTargets(ctx.model, ctx.impl, { allLayers });
  return targets.map((impl) => ({ impl, ...translateImplementation(ctx.model, impl) }));
}

function errorSection(t) {
  return {
    title: `${t.impl.name}: translation errors`,
    table: {
      columns: ["Problem", "Location"],
      rows: t.errors.map((e) => ({ status: "error", cells: [e.message, e.loc ? `${e.loc.file}:${e.loc.line}` : ""], loc: e.loc })),
    },
  };
}

async function verify(ctx, allLayers) {
  const translated = translateTargets(ctx, allLayers);
  if (!translated.length) {
    return { status: "warning", summary: `${ctx.impl.name} has no subcomponents or AGREE contracts to verify.`, sections: [] };
  }
  const sections = [];
  const files = [];
  let counts = { valid: 0, invalid: 0, unknown: 0, errors: 0 };
  const createSolver = ctx.services?.createSmtSolver || (async () => (await import("./z3-backend.js")).createZ3Session());
  const maxK = Number(ctx.settings?.agreeMaxK ?? 8);

  for (const t of translated) {
    files.push({ name: `${t.impl.name.replace(/\./g, "_")}.lus`, text: toLustre(t.program), mime: "text/plain" });
    if (t.errors.length) {
      counts.errors += t.errors.length;
      sections.push(errorSection(t));
      continue;
    }
    if (!t.program.props.length) {
      sections.push({ title: t.impl.name, text: t.program.warnings.join("\n") || "Nothing to check." });
      continue;
    }
    ctx.progress?.(`Verifying ${t.impl.name}…`);
    const solver = await createSolver();
    let result;
    const started = Date.now();
    try {
      result = await checkProgram(t.program, solver, { maxK, onProgress: (m) => ctx.progress?.(`${t.impl.name}: ${m}`) });
    } finally {
      solver.close?.();
    }
    const rows = result.props.filter((p) => !p.hidden).map((p) => {
      counts[p.status]++;
      const s = STATUS[p.status];
      const kText = p.status === "valid" ? `${p.k + 1}-inductive${p.joint ? " (jointly)" : ""}` : p.status === "invalid" ? `cex length ${p.k + 1}` : `no proof up to k=${maxK}`;
      return {
        status: s.status,
        cells: [s.label, p.kind, p.component || t.impl.name, p.desc, kText],
        loc: p.loc,
        details: p.cex ? cexDetails(p) : null,
      };
    });
    if (result.consistency.status === "inconsistent") {
      counts.invalid++;
      rows.unshift({
        status: "error",
        cells: ["Inconsistent", "consistency", t.impl.name, `No execution of ${result.consistency.depth + 1} steps satisfies all assumptions and subcomponent guarantees; every property would hold vacuously`, ""],
      });
    }
    const shown = result.props.filter((p) => !p.hidden).length;
    sections.push({
      title: `${t.impl.name} — ${shown} propert${shown === 1 ? "y" : "ies"} (${((Date.now() - started) / 1000).toFixed(1)} s)`,
      table: { columns: ["Result", "Kind", "Component", "Contract", "Proof"], rows },
      notes: t.program.warnings,
    });
  }

  const status = counts.errors || counts.invalid ? "error" : counts.unknown ? "warning" : "ok";
  const parts = [`${counts.valid} valid`, `${counts.invalid} invalid`, `${counts.unknown} unknown`];
  if (counts.errors) parts.push(`${counts.errors} translation error${counts.errors > 1 ? "s" : ""}`);
  return { status, summary: `AGREE ${allLayers ? "all layers" : "single layer"} on ${ctx.impl.name}: ${parts.join(", ")}`, sections, files };
}

function cexDetails(p) {
  const cex = p.cex;
  if (cex.error) return { title: "Counterexample", text: `${cex.error}\n${cex.raw}` };
  const steps = Array.from({ length: cex.steps }, (_, i) => `Step ${i}`);
  const rows = cex.rows.map((r) => ({ cells: [r.name, ...r.values], status: null }));
  rows.unshift({ cells: [`⟨${p.desc}⟩`, ...cex.property], status: "error", emphasis: true });
  return { title: `Counterexample (${cex.steps} step${cex.steps > 1 ? "s" : ""})`, table: { columns: ["Stream", ...steps], rows }, csv: true };
}

function exportLustre(ctx) {
  const translated = translateTargets(ctx, true);
  const files = translated.map((t) => ({ name: `${t.impl.name.replace(/\./g, "_")}.lus`, text: toLustre(t.program), mime: "text/plain" }));
  const sections = translated.map((t) => (t.errors.length ? errorSection(t) : { title: `${t.impl.name}.lus`, code: toLustre(t.program), notes: t.program.warnings }));
  const hasErrors = translated.some((t) => t.errors.length);
  return {
    status: hasErrors ? "error" : "ok",
    summary: `Generated ${files.length} Lustre program${files.length === 1 ? "" : "s"} for ${ctx.impl.name}`,
    sections,
    files,
  };
}

export default {
  id: "agree",
  name: "AGREE",
  version: "0.1.0",
  description:
    "Assume Guarantee REasoning Environment: compositional verification of AGREE annex contracts. " +
    "Contracts are translated to Lustre and proved by k-induction with Z3 (WebAssembly) in the browser.",
  annexes: {
    agree: {
      parse: (text, ctx) => parseAgree(text, ctx),
    },
  },
  editorKeywords: AGREE_KEYWORDS,
  analyses: [
    {
      id: "verify-single",
      label: "AGREE: Verify Single Layer",
      description: "Check the selected implementation against its direct subcomponents' contracts.",
      scope: "instance",
      mainThread: true,
      run: (ctx) => verify(ctx, false),
    },
    {
      id: "verify-all",
      label: "AGREE: Verify All Layers",
      description: "Verify every implementation in the hierarchy below the selected one.",
      scope: "instance",
      mainThread: true,
      run: (ctx) => verify(ctx, true),
    },
    {
      id: "export-lustre",
      label: "AGREE: Export Lustre",
      description: "Show and download the generated Lustre for JKind or Kind 2.",
      scope: "instance",
      run: (ctx) => exportLustre(ctx),
    },
  ],
  examples: AGREE_EXAMPLES,
};
