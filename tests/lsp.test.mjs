import { test } from "node:test";
import assert from "node:assert/strict";
import { makeHost } from "./helpers.mjs";
import { LanguageService, uriOf, positionAt } from "../src/lsp/service.js";
import { CORE_LIBRARIES } from "../src/core/library.js";
import { AGREE_EXAMPLES } from "../src/plugins/agree/examples.js";
import flowLatency from "../src/plugins/flow-latency.js";

const host = makeHost();
const pipeline = flowLatency.examples[0].files[0];
const counter = AGREE_EXAMPLES.find((e) => e.id === "agree-counter").files;

function service(files) {
  const ls = new LanguageService({ host, libraries: [...CORE_LIBRARIES, ...host.libraries] });
  for (const f of files) ls.setFile(f.name, f.text);
  return ls;
}

/** LSP position of the n-th occurrence of `needle` (plus `delta` characters) in a file. */
function at(file, needle, { nth = 0, delta = 0 } = {}) {
  let i = -1;
  for (let k = 0; k <= nth; k++) i = file.text.indexOf(needle, i + 1);
  assert.ok(i >= 0, `'${needle}' not found`);
  return positionAt(file.text, i + delta);
}

const lineText = (file, range) => file.text.split("\n")[range.start.line];

test("go to definition: classifier, subcomponent, feature, property, package", () => {
  const ls = service([pipeline]);
  const uri = uriOf(pipeline.name);
  // `ctrl: process Control.impl;` → implementation declaration
  let d = ls.definition(uri, at(pipeline, "Control.impl;", { delta: 9 }));
  assert.match(lineText(pipeline, d.range), /process implementation Control\.impl/);
  // `port sensor.reading` → feature `reading` of Sensor
  d = ls.definition(uri, at(pipeline, "sensor.reading", { delta: 8 }));
  assert.match(lineText(pipeline, d.range), /reading: out data port/);
  // `sensor.reading`'s head → the subcomponent declaration
  d = ls.definition(uri, at(pipeline, "sensor.reading", { delta: 1 }));
  assert.match(lineText(pipeline, d.range), /sensor: device Sensor/);
  // property name → Timing_Properties
  d = ls.definition(uri, at(pipeline, "Period => 10 ms"));
  assert.equal(d.uri, uriOf("Timing_Properties.aadl"));
  // Base_Types::Float → Base_Types package / Float classifier
  d = ls.definition(uri, at(pipeline, "Base_Types::Float", { delta: 13 }));
  assert.equal(d.uri, uriOf("Base_Types.aadl"));
  // enum literal → the enumeration type
  d = ls.definition(uri, at(pipeline, "Periodic;"));
  assert.equal(d.uri, uriOf("AADL_Project.aadl"));
});

test("definition inside an AGREE annex and across files", () => {
  const ls = service(counter);
  const sys = counter.find((f) => f.name === "Counter_System.aadl");
  const uri = uriOf(sys.name);
  let d = ls.definition(uri, at(sys, "ctr.count < ", { delta: 5 }));
  assert.match(lineText(sys, d.range), /count: out data port/);
  d = ls.definition(uri, at(sys, "Counter_Lib::MAX", { delta: 14 }));
  assert.equal(d.uri, uriOf("Counter_Lib.aadl"));
  assert.match(counter[0].text.split("\n")[d.range.start.line], /const MAX/);
});

test("find references and rename a classifier across the workspace", () => {
  const ls = service([pipeline]);
  const uri = uriOf(pipeline.name);
  const refs = ls.references(uri, at(pipeline, "device Sensor", { delta: 7 }));
  assert.equal(refs.length, 3, JSON.stringify(refs)); // declaration, end Sensor;, subcomponent classifier
  const edit = ls.rename(uri, at(pipeline, "device Sensor", { delta: 7 }), "Camera");
  assert.equal(edit.changes[uri].length, 3);
  assert.throws(() => ls.rename(uri, at(pipeline, "Period =>"), "Foo"), /read-only/);
});

test("rename a subcomponent updates connections, flows and applies-to", () => {
  const ls = service([pipeline]);
  const uri = uriOf(pipeline.name);
  const edit = ls.rename(uri, at(pipeline, "ctrl: process"), "controller");
  // declaration, s2c, c2a, end-to-end flow segment, two applies-to paths
  assert.equal(edit.changes[uri].length, 6, JSON.stringify(edit.changes[uri].map((e) => lineText(pipeline, e.range))));
});

test("completion: property names, enum values, units, classifiers, endpoints", () => {
  // Lines are joined explicitly: several end in a significant trailing space.
  const files = [{ name: "c.aadl", text: [
    "package C", "public", "  with Base_Types, SEI;", "  thread T", "    features",
    "      y: out data port Base_Types::Integer;",
    "      x: in data port Base_Types::", "    properties", "      Disp", "      Dispatch_Protocol => ",
    "      Period => 10 ", "  end T;", "  thread implementation T.i", "  end T.i;", "  process P", "  end P;",
    "  process implementation P.i", "    subcomponents", "      t2: thread T.i;", "      t1: thread ", "    connections", "      c1: port t2.",
    "  end P.i;", "end C;",
  ].join("\n") }];
  const ls = service(files);
  const uri = uriOf("c.aadl");
  const labels = (needle, delta) => ls.completion(uri, at(files[0], needle, { delta })).items.map((i) => i.label);
  assert.ok(labels("Base_Types::\n", 12).includes("Integer"), labels("Base_Types::\n", 12).join(", "));
  assert.ok(labels("Disp\n", 4).includes("Dispatch_Protocol"), labels("Disp\n", 4).join(", "));
  assert.ok(labels("Disp\n", 4).includes("SEI::MIPSBudget"), labels("Disp\n", 4).join(", "));
  assert.ok(labels("Dispatch_Protocol => \n", 21).includes("Sporadic"), labels("Dispatch_Protocol => \n", 21).join(", "));
  assert.deepEqual(labels("Period => 10 \n", 13).slice(0, 3), ["ps", "ns", "us"]);
  assert.ok(labels("t1: thread \n", 11).includes("T.i"), labels("t1: thread \n", 11).join(", "));
  assert.ok(labels("port t2.\n", 8).includes("y"), labels("port t2.\n", 8).join(", "));
});

test("hover, symbols, folding and diagnostics", () => {
  const ls = service([pipeline]);
  const uri = uriOf(pipeline.name);
  const h = ls.hover(uri, at(pipeline, "Latency => 0.5 ms"));
  assert.match(h.contents.value, /Timing_Properties::Latency/);
  const syms = ls.documentSymbols(uri);
  assert.equal(syms[0].name, "Sensor_Pipeline");
  assert.ok(syms[0].children.some((c) => c.name === "Vehicle.impl" && c.children.length >= 5));
  const folds = ls.foldingRanges(uri);
  assert.ok(folds.length > 10);
  ls.setFile(pipeline.name, pipeline.text.replace("Period => 10 ms", "Period => 10 kg"));
  const diags = ls.diagnostics(uri);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, 1);
  assert.match(diags[0].message, /not a unit of Period/);
});
