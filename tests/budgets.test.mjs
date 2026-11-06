import { test } from "node:test";
import assert from "node:assert/strict";
import { build, errors, makeHost } from "./helpers.mjs";
import { instantiate } from "../src/core/instance.js";
import { responseTimes } from "../src/plugins/schedulability.js";

const host = makeHost();
const ex = host.examples.find((e) => e.id === "flight-computer");
const setup = (edit = (t) => t) => {
  const model = build(ex.files.map((f) => ({ ...f, text: edit(f.text) })), host);
  const impl = model.findByQualifiedName(ex.target);
  return { model, impl, instance: instantiate(model, impl).root };
};
const run = (key, ctx) => host.analyses.find((a) => a.key === key).run(ctx);

test("flight computer example is clean", () => {
  assert.deepEqual(errors(setup().model), []);
});

test("response-time analysis matches the textbook example", () => {
  // C/T: (1,4) (2,6) (3,13) → R = 1, 3, 10 (rate monotonic)
  const r = responseTimes([{ T: 4, C: 1, D: 4 }, { T: 6, C: 2, D: 6 }, { T: 13, C: 3, D: 13 }], (a, b) => a.T - b.T);
  assert.deepEqual(r.map((t) => t.R), [1, 3, 10]);
  assert.ok(r.every((t) => t.ok));
});

test("schedulability follows partition bindings to the physical processor", async () => {
  const res = await run("schedulability:rta", setup());
  assert.equal(res.status, "ok");
  const rows = res.sections[0].table.rows.map((r) => [r.cells[0], r.cells[7]]);
  assert.deepEqual(rows, [["fctl.law", "3 ms"], ["nav.estimator", "7 ms"], ["nav.logger", "20 ms"]]);
});

test("an overloaded processor is reported unschedulable", async () => {
  const res = await run("schedulability:rta", setup((t) => t.replace("Compute_Execution_Time => 2 ms .. 4 ms;", "Compute_Execution_Time => 2 ms .. 16 ms;")));
  assert.equal(res.status, "error");
  assert.match(res.summary, /NOT schedulable/);
});

test("processor load, RAM and bus bandwidth budgets", async () => {
  const ctx = setup();
  const cpu = await run("resource-budgets:processor-load", ctx);
  assert.match(cpu.summary, /cpu 75\.0%/);
  const ram = await run("resource-budgets:memory", ctx);
  assert.match(ram.summary, /RAM: cpu 68\.8%/);
  const bus = await run("resource-budgets:bus-load", ctx);
  assert.match(bus.summary, /can 2\.6%/);
  const over = await run("resource-budgets:processor-load", setup((t) => t.replace("SEI::MIPSCapacity => 120.0 MIPS;", "SEI::MIPSCapacity => 80.0 MIPS;")));
  assert.equal(over.status, "error");
});
