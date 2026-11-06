import { test } from "node:test";
import assert from "node:assert/strict";
import { build, errors, makeHost } from "./helpers.mjs";
import { instantiate } from "../src/core/instance.js";
import { EMV2_EXAMPLE } from "../src/plugins/emv2/example.js";
import { ErrorModel, faultTree, fmea, toOpenPsa } from "../src/plugins/emv2/semantics.js";

const host = makeHost();
const setup = (edit = (t) => t) => {
  const model = build(EMV2_EXAMPLE.files.map((f) => ({ ...f, text: edit(f.text) })), host);
  const impl = model.findByQualifiedName(EMV2_EXAMPLE.target);
  return { model, impl, root: impl ? instantiate(model, impl).root : null };
};
const run = (key, ctx) => host.analyses.find((a) => a.key === key).run(ctx);

test("EMV2 example parses and validates cleanly; types follow the standard hierarchy", () => {
  const { model } = setup();
  assert.deepEqual(errors(model), []);
  const em = new ErrorModel(model);
  assert.ok(em.isSubtype("errorlibrary::aboverange", "errorlibrary::valuerelatederror"));
  assert.ok(!em.isSubtype("errorlibrary::serviceomission", "errorlibrary::valuerelatederror"));
});

test("EMV2 legality: unknown types, points, states and subcomponents are reported", () => {
  const { model } = setup((t) => t
    .replace("reading: out propagation {ServiceOmission, OutOfRange};", "reading: out propagation {ServiceOmision, OutOfRange};\n        nowhere: in propagation {ServiceOmission};")
    .replace("[ pump.FailStop or", "[ pmp.FailStop or")
    .replace("no_cmd: Operational -[ cmd{ServiceOmission} ]-> FailStop;", "no_cmd: Operational -[ cmd{ServiceOmission} ]-> Broken;"));
  const msgs = errors(model).map((d) => d.message);
  for (const re of [/unknown error type 'ServiceOmision'/, /'nowhere' is not a feature/, /unknown subcomponent 'pmp'/, /unknown error state/]) {
    assert.ok(msgs.some((m) => re.test(m)), `${re} not in:\n${msgs.join("\n")}`);
  }
});

test("FMEA rows follow propagation to the end effect", () => {
  const { model, root } = setup();
  const rows = fmea(new ErrorModel(model), model, root);
  const range = rows.find((r) => r.component === "s1" && /OutOfRange/.test(r.failureMode));
  assert.match(range.nextEffect, /ctrl\.in1/);
  assert.match(range.endEffect, /error sink bad_cmd/);
  assert.equal(range.severity, "Major");
  assert.equal(range.probability, 5e-5);
  assert.equal(range.detection, "Range check in controller");
});

test("fault tree: minimal cut sets and top-event probability", () => {
  const { model, root } = setup();
  const r = faultTree(new ErrorModel(model), model, root, { inst: root, state: "FailStop" });
  const cuts = r.cuts.map((c) => c.events.map((e) => e.label).sort().join(" & ")).sort();
  assert.deepEqual(cuts, ["ctrl: Failure", "pump: Failure", "s1: Failure & s2: Failure"]);
  const expected = 1 - (1 - 2e-5) * (1 - 1e-6) * (1 - 1e-8);
  assert.ok(Math.abs(r.probability - expected) < 1e-12);
  const xml = toOpenPsa("top", r);
  assert.match(xml, /<opsa-mef>/);
  assert.match(xml, /<define-basic-event name="s1\.Failure">/);
});

test("EMV2 analyses run through the plug-in host", async () => {
  const { model, impl, root } = setup();
  const ctx = { model, impl, instance: root };
  assert.equal((await run("emv2:propagation", ctx)).status, "ok");
  const fta = await run("emv2:fta", ctx);
  assert.equal(fta.files.length, 2);
  const hz = await run("emv2:hazards", ctx);
  assert.equal(hz.sections[0].table.rows[0].cells[0], "H-1");
  assert.equal(hz.sections[0].table.rows[0].cells[8], "Hazardous");
});
