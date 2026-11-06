#!/usr/bin/env node
// WOSATE headless CLI: the browser workbench's parser, validator, analyses and
// language server, run from a terminal or a CI job.
//
//   wosate check [paths…] [--format text|github|json]
//   wosate analyze <analysis…> --target Pkg::Impl [paths…] [--out dir] [--fail-on error|warning] [--format …]
//   wosate list
//   wosate lsp --stdio                      Language Server Protocol over stdin/stdout
//
// Paths may be files or directories (searched recursively for .aadl / .aadl2).
// Exit code 1 when errors are found (or the --fail-on level is reached).

import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { PluginHost } from "../src/core/plugin-host.js";
import { buildModel } from "../src/core/model.js";
import { instantiate } from "../src/core/instance.js";
import { CORE_LIBRARIES } from "../src/core/library.js";
import { BUILTIN_PLUGINS } from "../src/plugins/index.js";

const args = process.argv.slice(2);
const command = args[0];
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const positional = () => {
  const out = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (!["--stdio"].includes(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
};

const host = new PluginHost();
for (const p of BUILTIN_PLUGINS) host.register(p);
const libraries = [...CORE_LIBRARIES, ...host.libraries];

function collect(paths) {
  const files = [];
  const walk = (p) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const e of readdirSync(p)) if (!e.startsWith(".") && e !== "node_modules") walk(join(p, e));
    } else if (/\.aadl2?$/i.test(p)) {
      files.push({ name: relative(process.cwd(), p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") });
    }
  };
  for (const p of paths.length ? paths : ["."]) walk(p);
  return files;
}

const format = opt("format", process.env.GITHUB_ACTIONS ? "github" : "text");
const escapeGh = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");

function report(diags) {
  const user = diags.filter((d) => !libraries.some((l) => l.name === d.file));
  if (format === "json") {
    process.stdout.write(JSON.stringify(user, null, 2) + "\n");
  } else {
    for (const d of user) {
      if (format === "github") {
        const level = d.severity === "error" ? "error" : d.severity === "warning" ? "warning" : "notice";
        console.log(`::${level} file=${d.file},line=${d.line},col=${d.col || 1},title=${escapeGh(d.source || "aadl")}::${escapeGh(d.message)}`);
      } else {
        console.log(`${d.file}:${d.line}:${d.col || 1}: ${d.severity}: ${d.message}${d.source ? ` [${d.source}]` : ""}`);
      }
    }
  }
  const errors = user.filter((d) => d.severity === "error").length;
  const warnings = user.filter((d) => d.severity === "warning").length;
  if (format !== "json") console.error(`${errors} error(s), ${warnings} warning(s)`);
  return { errors, warnings };
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");
}

function resultMarkdown(analysis, result, target) {
  const icon = { ok: "✅", warning: "⚠️", error: "❌", info: "ℹ️" }[result.status] || "";
  const lines = [`### ${icon} ${analysis.label}${target ? ` — \`${target}\`` : ""}`, "", result.summary || "", ""];
  for (const s of result.sections || []) {
    if (!s.table) continue;
    lines.push(`**${s.title}**`, "", `| ${s.table.columns.join(" | ")} |`, `| ${s.table.columns.map(() => "---").join(" | ")} |`);
    for (const r of s.table.rows.slice(0, 50)) lines.push(`| ${r.cells.map((c) => String(c).replace(/\|/g, "\\|").trim()).join(" | ")} |`);
    if (s.table.rows.length > 50) lines.push(`| … ${s.table.rows.length - 50} more rows | |`);
    lines.push("");
  }
  return lines.join("\n");
}

async function smtSolver() {
  const { init } = await import("z3-solver");
  const z3 = await (smtSolver.z3 ||= init());
  const { sessionFromLowLevel } = await import("../src/plugins/agree/z3-backend.js");
  return sessionFromLowLevel(z3.Z3);
}

async function main() {
  if (!command || command === "help" || command === "--help") {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("\n").slice(1, 13).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    return 0;
  }
  if (command === "list") {
    for (const a of host.analyses) console.log(`${a.key.padEnd(36)} ${a.label}${a.scope === "instance" ? "  (needs --target)" : ""}`);
    return 0;
  }
  if (command === "lsp") {
    await import("./lsp-stdio.mjs");
    return null;
  }
  if (command === "check") {
    const files = collect(positional());
    if (!files.length) {
      console.error("No .aadl files found");
      return 1;
    }
    const model = buildModel([...libraries, ...files], host);
    const { errors } = report(model.diagnostics);
    summary(`### ${errors ? "❌" : "✅"} AADL check\n\n${files.length} file(s), ${model.packages.size - libraries.length + 1} package(s): ${errors} error(s), ${model.diagnostics.filter((d) => d.severity === "warning" && !libraries.some((l) => l.name === d.file)).length} warning(s).\n`);
    return errors ? 1 : 0;
  }
  if (command === "analyze") {
    const pos = positional();
    const wanted = (pos[0] || "").split(",").filter(Boolean);
    const paths = pos.slice(1);
    const target = opt("target");
    const failOn = opt("fail-on", "error");
    const outDir = opt("out");
    const files = collect(paths);
    const model = buildModel([...libraries, ...files], host);
    const { errors } = report(model.diagnostics);
    if (errors) return 1;
    let worst = "ok";
    const rank = { ok: 0, info: 0, warning: 1, error: 2 };
    for (const key of wanted) {
      const analysis = host.analyses.find((a) => a.key === key || a.id === key);
      if (!analysis) {
        console.error(`Unknown analysis '${key}' (see: wosate list)`);
        return 1;
      }
      const impl = target ? model.findByQualifiedName(target) : null;
      const ctx = { model, impl, settings: { agreeMaxK: Number(opt("max-k", 8)) }, libraryFiles: new Set(libraries.map((l) => l.name)), services: { createSmtSolver: smtSolver }, progress: () => {} };
      if (analysis.scope !== "model") {
        if (!impl) {
          console.error(`${analysis.label} needs --target Pkg::Impl (${target ? `'${target}' not found` : "missing"})`);
          return 1;
        }
        const { root, problems } = instantiate(model, impl);
        ctx.instance = root;
        ctx.instanceProblems = problems;
      }
      const result = await analysis.run(ctx);
      if (rank[result.status] > rank[worst]) worst = result.status;
      if (format === "json") process.stdout.write(JSON.stringify({ analysis: analysis.key, ...result }, null, 2) + "\n");
      else {
        console.log(`\n== ${analysis.label}: ${result.status.toUpperCase()} — ${result.summary}`);
        for (const s of result.sections || []) {
          if (!s.table) continue;
          console.log(`\n  ${s.title}`);
          for (const r of s.table.rows) console.log(`    ${r.status === "error" ? "✗" : r.status === "warning" ? "!" : " "} ${r.cells.map((c) => String(c).trim()).join(" | ")}`);
        }
        if (format === "github" && result.status === "error") console.log(`::error title=${escapeGh(analysis.label)}::${escapeGh(result.summary)}`);
        if (format === "github" && result.status === "warning") console.log(`::warning title=${escapeGh(analysis.label)}::${escapeGh(result.summary)}`);
      }
      summary(resultMarkdown(analysis, result, analysis.scope === "model" ? null : target));
      if (outDir && result.files?.length) {
        for (const f of result.files) {
          const p = resolve(outDir, f.name);
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.text);
        }
        console.error(`wrote ${result.files.length} file(s) to ${outDir}`);
      }
    }
    smtSolver.z3?.then((z) => z.em.PThread.terminateAllThreads());
    return rank[worst] >= (failOn === "warning" ? 1 : 2) ? 1 : 0;
  }
  console.error(`Unknown command '${command}'. Try: wosate help`);
  return 1;
}

const code = await main();
if (code !== null) process.exit(code);
