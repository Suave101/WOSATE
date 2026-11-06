import { test } from "node:test";
import assert from "node:assert/strict";
import { build, errors, makeHost } from "./helpers.mjs";
import { parseAadl } from "../src/core/aadl-parser.js";
import { instantiate, instanceProperty } from "../src/core/instance.js";
import { toBase } from "../src/core/properties.js";
import flowLatency from "../src/plugins/flow-latency.js";

const pipeline = flowLatency.examples[0];

test("parser reads packages, classifiers, features, connections, flows and properties", () => {
  const { units, diagnostics } = parseAadl(pipeline.files[0].text, "p.aadl");
  assert.deepEqual(diagnostics, []);
  const pkg = units[0];
  assert.equal(pkg.name, "Sensor_Pipeline");
  const vehicle = pkg.classifiers.find((c) => c.name === "Vehicle.impl");
  assert.equal(vehicle.subcomponents.length, 5);
  assert.equal(vehicle.connections[0].src.context, "sensor");
  assert.equal(vehicle.flows[0].flowKind, "end to end");
  assert.deepEqual(vehicle.flows[0].segments, ["sensor.src", "s2c", "ctrl.path1", "c2a", "act.snk"]);
  const binding = vehicle.properties.find((p) => p.name === "Actual_Processor_Binding");
  assert.deepEqual(binding.appliesTo, ["ctrl"]);
  assert.equal(binding.value.items[0].type, "reference");
});

test("parser recovers after a broken classifier and reports the line", () => {
  const { units, diagnostics } = parseAadl(`package P
public
  system Broken
    features
      x: in data port oops oops;
  end Broken;
  system Fine
  end Fine;
end P;`);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, 5);
  assert.ok(units[0].classifiers.some((c) => c.name === "Fine"));
});

test("name resolution: missing with clause, unknown classifier, bad direction", () => {
  const model = build([
    { name: "Lib.aadl", text: "package Lib\npublic\n  system S\n  end S;\nend Lib;" },
    {
      name: "Main.aadl",
      text: `package Main
public
  with Base_Types;
  system T
    features
      i: in data port Base_Types::Integer;
      o: out data port Base_Types::Integer;
  end T;
  system implementation T.impl
    subcomponents
      a: system Lib::S;
      b: system Missing;
      t2: system T;
    connections
      c1: port t2.i -> o;
  end T.impl;
end Main;`,
    },
  ]);
  const msgs = errors(model).map((d) => d.message);
  assert.ok(msgs.some((m) => /not listed in the with clause/.test(m)), msgs.join("\n"));
  assert.ok(msgs.some((m) => /Classifier 'Missing' not found/.test(m)));
  assert.ok(msgs.some((m) => /cannot be a connection source/.test(m)));
});

test("instance model applies contained property associations", () => {
  const model = build(pipeline.files);
  assert.deepEqual(errors(model), []);
  const { root } = instantiate(model, model.findByQualifiedName(pipeline.target));
  assert.equal(root.children.length, 5);
  const ctrl = root.child("ctrl");
  assert.equal(ctrl.children[0].name, "filt");
  assert.equal(toBase(instanceProperty(model, ctrl, "Latency", "path1").max, "time"), 0.003);
  assert.equal(toBase(instanceProperty(model, ctrl.child("filt"), "Period"), "time"), 0.01);
});

test("flow latency, weight and power analyses", async () => {
  const host = makeHost();
  const model = build(pipeline.files, host);
  const impl = model.findByQualifiedName(pipeline.target);
  const { root } = instantiate(model, impl);
  const ctx = { model, impl, instance: root };
  const run = (key) => host.analyses.find((a) => a.key === key).run(ctx);

  const latency = await run("flow-latency:flow-latency");
  assert.equal(latency.status, "ok");
  const total = latency.sections[0].table.rows.at(-1).cells[2];
  assert.equal(total, "7 ms .. 12 ms");

  const weight = await run("resource-budgets:weight");
  assert.equal(weight.status, "ok");
  assert.match(weight.summary, /3\.7 kg/);

  const power = await run("resource-budgets:power");
  // The example is deliberately over budget: 1.5 + 12 + 8 W against a 20 W battery.
  assert.equal(power.status, "error");
  assert.match(power.summary, /Demand 21\.5 W exceeds capacity 20 W/);
});

test("instance view produces an SVG diagram", async () => {
  const host = makeHost();
  const model = build(pipeline.files, host);
  const impl = model.findByQualifiedName(pipeline.target);
  const { root } = instantiate(model, impl);
  const res = await host.analyses.find((a) => a.key === "instance-view:instantiate").run({ model, impl, instance: root });
  assert.match(res.sections[0].svg, /^<svg/);
  assert.match(res.sections[0].svg, /sensor/);
});

test("third-party plug-ins can validate and contribute analyses", async () => {
  const host = makeHost();
  const ext = (await import("../public/plugins/naming-conventions.js")).default;
  host.register(ext, { source: "test" });
  const model = build([{ name: "x.aadl", text: "package X\npublic\n  system lower\n  end lower;\nend X;" }], host);
  assert.ok(model.diagnostics.some((d) => d.source === "naming-conventions" && /upper-case/.test(d.message)));
  const res = await host.analyses.find((a) => a.key === "naming-conventions:summary").run({ model });
  assert.match(res.summary, /classifiers/);
});
